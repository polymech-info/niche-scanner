import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { run, type IKBotTask } from '@polymech/kbot-d';

import { createLogger } from '@/commons/logger.js';
import { getUserCached } from '@/commons/zitadel.js';
import { z } from 'zod';
import { streamSSE } from 'hono/streaming';

import { getGridSearchRunById, getPlaceById, updatePlaceMeta, fetchUserSecretsSettingsPg } from './db-places.js';
import { PlacesLibrary } from './places.js';
import { EventBus } from '../EventBus.js';

const logger = createLogger('places-llm');

const GRID_REQUEST_JSON_MAX = 14000;

async function resolveUserIdFromContext(c: any): Promise<string | undefined> {
    const ctxUserId = c.get('userId');
    if (ctxUserId) return ctxUserId;
    const authHeader = c.req.header('Authorization') || c.req.header('authorization');
    let token = authHeader?.replace(/bearer\s+/i, '');
    if (!token) token = c.req.query('token');
    if (token) {
        const user = await getUserCached(token);
        return user?.id;
    }
    return undefined;
}

/** Strip secrets / user id before sending grid request JSON to the LLM. */
function sanitizeGridSearchRequestForLlm(req: unknown): unknown {
    if (req == null || typeof req !== 'object') return req;
    const o = { ...(req as Record<string, unknown>) };
    delete o.userId;
    delete o.runId;
    return o;
}

function gridSearchRequestToPromptText(req: unknown): string {
    const sanitized = sanitizeGridSearchRequestForLlm(req);
    let s = JSON.stringify(sanitized, null, 0);
    if (s.length > GRID_REQUEST_JSON_MAX) {
        s = `${s.slice(0, GRID_REQUEST_JSON_MAX)}\n…[truncated]`;
    }
    return s;
}

/** Aligns with pm-pics/src/i18n.tsx supportedLanguages */
const LANG_ISO_NAMES: Record<string, string> = {
    en: 'English',
    fr: 'French',
    sw: 'Swahili',
    de: 'German',
    es: 'Spanish',
    nl: 'Dutch',
    ja: 'Japanese',
    ko: 'Korean',
    pt: 'Portuguese',
    ru: 'Russian',
    tr: 'Turkish',
    it: 'Italian',
    zh: 'Chinese',
};

function normalizeLangIso(raw: string | undefined | null): string | undefined {
    if (raw == null || raw === '') return undefined;
    const t = String(raw).trim().toLowerCase().slice(0, 2);
    return t.length === 2 ? t : undefined;
}

/** Appended to LLM prompts so string values match the UI locale (see i18n). */
export function languagePromptSuffix(langIso: string | undefined | null): string {
    const iso = normalizeLangIso(langIso);
    if (!iso) return '';
    const name = LANG_ISO_NAMES[iso] ?? iso.toUpperCase();
    const code = iso.toUpperCase();
    return `\n\nRespond in ${name} for UI language ISO 639-1: ${code}. Keep JSON keys in English; translate natural-language string values only.`;
}

function resolvePromptPath(envKey: string, defaultRelative: string): string {
    const v = process.env[envKey];
    if (v && v.length > 0) {
        return path.isAbsolute(v) ? v : path.join(process.cwd(), v);
    }
    return path.join(process.cwd(), defaultRelative);
}

function completionResultToText(result: unknown): string {
    if (result == null) return '';
    if (typeof result === 'string') return result;
    if (typeof result === 'object' && result !== null && 'content' in result) {
        const content = (result as { content?: unknown }).content;
        if (typeof content === 'string') return content;
    }
    if (typeof result === 'object') return JSON.stringify(result);
    return String(result);
}

function buildPlaceSubstituteVars(
    place: Record<string, unknown>,
    gridSearchContextJson: string,
): Record<string, string> {
    const maxSiteChars = Number(process.env.LLM_PLACE_INFO_MAX_SITE_CHARS) || 12000;
    const emails = Array.isArray(place.emails) ? place.emails : [];
    const rawSites = Array.isArray(place.sites) ? place.sites : [];
    const sitesTrimmed = rawSites.map((s: any) => {
        const content = typeof s?.content === 'string' ? s.content : '';
        const trimmed =
            content.length > maxSiteChars ? `${content.slice(0, maxSiteChars)}\n…[truncated]` : content;
        return {
            url: s?.url ?? '',
            name: s?.name ?? '',
            content: trimmed,
        };
    });
    return {
        place_id: String(place.place_id ?? ''),
        title: String(place.title ?? ''),
        address: String(place.address ?? ''),
        types: Array.isArray(place.types) ? (place.types as string[]).join(', ') : '',
        emails_json: JSON.stringify(emails),
        sites_json: JSON.stringify(sitesTrimmed),
        grid_search_context: gridSearchContextJson || '(none — open place detail outside a grid search run)',
    };
}

async function runLlmJsonCompletion(
    promptContent: string,
    sinkPrefix: string,
    provider: string,
    model: string,
): Promise<{ data: unknown } | { error: string; status: number }> {
    try {
        const task: IKBotTask = {
            router: provider,
            model,
            prompt: promptContent,
            mode: 'completion',
            path: '.',
            include: [],
            silent: true,
        };

        logger.info(
            { sinkPrefix, provider, model, promptLength: promptContent.length, prompt: promptContent },
            `${sinkPrefix}: request`,
        );

        const results = await run(task);
        const raw = results.length > 0 ? results[0] : null;

        let jsonStr = completionResultToText(raw);
        jsonStr = jsonStr.replace(/```json\n?|```/g, '').trim();

        if (!jsonStr) {
            logger.error(
                { sinkPrefix, provider, model, resultsCount: results.length, rawType: typeof raw, raw },
                `${sinkPrefix}: empty LLM response`,
            );
            return { error: 'LLM returned no content', status: 502 };
        }

        try {
            const data = JSON.parse(jsonStr);
            logger.info(
                { sinkPrefix, provider, model, rawLength: jsonStr.length, raw: jsonStr, data },
                `${sinkPrefix}: response`,
            );
            return { data };
        } catch (e) {
            logger.error({ sinkPrefix, jsonStr, err: e }, `${sinkPrefix}: failed to parse LLM JSON`);
            return { error: 'Failed to parse LLM response', status: 500 };
        }
    } catch (err: unknown) {
        logger.error({ err }, `${sinkPrefix}: LLM run failed`);
        const message = err instanceof Error ? err.message : 'LLM request failed';
        return { error: message, status: 500 };
    }
}

export async function handleGetLlmRegionInfo(c: any) {
    const { location, lang } = c.req.valid('query') as { location: string; lang?: string };
    try {
        const promptPath = resolvePromptPath('LLM_REGION_INFO_PROMPT_PATH', 'data/products/places/llm/region-info.md');
        const rawMd = await readFile(promptPath, 'utf8');
        const { substitute } = await import('@polymech/commons/variables');
        let promptContent = substitute(false, rawMd, { location }, true);
        promptContent += languagePromptSuffix(lang);

        const provider = process.env.LLM_REGION_PROVIDER ?? 'openrouter';
        const model = process.env.LLM_REGION_MODEL ?? 'openai/gpt-5.2';

        const out = await runLlmJsonCompletion(promptContent, 'kbot-llm-region', provider, model);
        if ('error' in out) return c.json({ error: out.error }, out.status);
        return c.json({ data: out.data }, 200);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        logger.error({ err: error }, 'Error fetching LLM region info');
        return c.json({ error: message }, 500);
    }
}

const PLACE_INFO_CONTEXT_MAX = 8000;

export async function handleGetPlaceInfo(c: any) {
    const { place_id } = c.req.valid('param');
    const { lang, runId, context: contextRaw } = c.req.valid('query') as {
        lang?: string;
        runId?: string;
        context?: string;
    };
    try {
        const place = await PlacesLibrary.getPlaceById(place_id);

        const manualContext =
            typeof contextRaw === 'string' && contextRaw.trim().length > 0
                ? contextRaw.trim().slice(0, PLACE_INFO_CONTEXT_MAX)
                : '';

        let gridSearchContextJson = '';
        if (manualContext) {
            gridSearchContextJson =
                'USER-DEFINED CONTEXT (primary signal for potentialCustomer — overrides grid run JSON when both exist):\n' +
                manualContext;
        } else if (runId && String(runId).trim()) {
            const { data: run, error } = await getGridSearchRunById(String(runId).trim());
            if (error || !run) {
                return c.json({ error: 'Grid search run not found' }, 404);
            }
            const userId = await resolveUserIdFromContext(c);
            const isOwner = run.user_id === userId;
            const isPublic = run.settings?.is_public === true;
            if (!isOwner && !isPublic) {
                return c.json({ error: 'Unauthorized' }, 401);
            }
            gridSearchContextJson = gridSearchRequestToPromptText(run.request);
        }

        const promptPath = resolvePromptPath('LLM_PLACE_INFO_PROMPT_PATH', 'data/products/places/llm/place-info.md');
        const rawMd = await readFile(promptPath, 'utf8');
        const { substitute } = await import('@polymech/commons/variables');
        const vars = buildPlaceSubstituteVars(place as Record<string, unknown>, gridSearchContextJson);
        let promptContent = substitute(false, rawMd, vars, true);
        promptContent += languagePromptSuffix(lang);

        const provider = process.env.LLM_PLACE_PROVIDER ?? process.env.LLM_REGION_PROVIDER ?? 'openrouter';
        const model =
            process.env.LLM_PLACE_MODEL ?? process.env.LLM_REGION_MODEL ?? 'openai/gpt-5.2';

        const out = await runLlmJsonCompletion(promptContent, 'kbot-llm-place', provider, model);
        if ('error' in out) return c.json({ error: out.error }, out.status);
        return c.json({ data: out.data }, 200);
    } catch (error: unknown) {
        const status = typeof error === 'object' && error !== null && 'status' in error ? (error as any).status : undefined;
        if (status === 404) {
            return c.json({ error: 'Place not found' }, 404);
        }
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        logger.error({ err: error }, 'Error fetching LLM place info');
        return c.json({ error: message }, 500);
    }
}

// ─── AI grid filters (meta.llm_grid_filters) ─────────────────────────────────

const LLM_GRID_FILTER_TEMPLATE_VERSION = '2';

export const AiGridFilterResultSchema = z.object({
    value: z.union([z.string(), z.number()]),
    /** LLM may set `"number"` for scales/scores so we coerce `value` for DataGrid; optional. */
    value_type: z.enum(['number', 'string']).optional(),
    detail: z.string().optional(),
});

export type AiGridFilterResult = z.infer<typeof AiGridFilterResultSchema>;

const AiGridFilterDefSchema = z.object({
    id: z.string().min(1),
    label: z.string(),
    prompt: z.string(),
    targetField: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    enabled: z.boolean().optional(),
    /** Client: how to coerce `value` for sorting/filtering (`auto` = infer from prompt + value). */
    valueType: z.enum(['auto', 'number', 'string']).optional(),
});

export type AiGridFilterDef = z.infer<typeof AiGridFilterDefSchema>;

const RESERVED_GRID_FIELDS = new Set([
    'thumbnail', 'title', 'email', 'phone', 'address', 'city', 'country', 'website', 'rating', 'types', 'social',
]);

function parseAiGridFilterDefs(settings: Record<string, unknown> | null | undefined): AiGridFilterDef[] {
    const raw = settings?.places_ai_grid_filters;
    if (!Array.isArray(raw)) return [];
    const out: AiGridFilterDef[] = [];
    for (const item of raw) {
        const p = AiGridFilterDefSchema.safeParse(item);
        if (p.success && !RESERVED_GRID_FIELDS.has(p.data.targetField)) {
            out.push({ ...p.data, enabled: p.data.enabled !== false });
        }
    }
    return out;
}

function hashGridFilterPrompt(def: AiGridFilterDef): string {
    const h = createHash('sha256');
    h.update(LLM_GRID_FILTER_TEMPLATE_VERSION);
    h.update('\n');
    h.update(def.id);
    h.update('\n');
    h.update(def.prompt);
    h.update('\n');
    h.update(def.targetField);
    h.update('\n');
    h.update(def.valueType ?? 'auto');
    return h.digest('hex').slice(0, 32);
}

/** Parse a plain numeric cell (e.g. scale 1–5); leave labels like "yes" unchanged. */
function tryCoerceNumericCell(value: string | number): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    const s = String(value).trim();
    if (/^-?\d+(\.\d+)?$/.test(s)) {
        const n = Number(s);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/** Normalize stored cell `value` for MUI filters (number vs string). */
function normalizeAiGridFilterValue(def: AiGridFilterDef, data: AiGridFilterResult): string | number {
    const userPref = def.valueType ?? 'auto';
    const llmVt = data.value_type;

    if (userPref === 'number') {
        const n = tryCoerceNumericCell(data.value);
        return n !== null ? n : String(data.value);
    }
    if (userPref === 'string') {
        return String(data.value);
    }

    // auto
    if (llmVt === 'number') {
        const n = tryCoerceNumericCell(data.value);
        return n !== null ? n : String(data.value);
    }
    if (llmVt === 'string') {
        return String(data.value);
    }
    const n = tryCoerceNumericCell(data.value);
    if (n !== null) {
        return n;
    }
    return typeof data.value === 'number' ? data.value : String(data.value);
}

function buildGridFilterVars(
    place: Record<string, unknown>,
    def: Pick<AiGridFilterDef, 'label' | 'prompt' | 'targetField' | 'valueType'>,
): Record<string, string> {
    const base = buildPlaceSubstituteVars(place, '(none — grid filter)');
    return {
        ...base,
        filter_prompt: def.prompt,
        filter_label: def.label,
        target_field: def.targetField,
        value_type_hint: def.valueType ?? 'auto',
    };
}

/** Env chain for AI grid filters: explicit grid → place filters (.env) → shared place/region → defaults. */
function gridFilterLlmProvider(): string {
    return (
        process.env.LLM_GRID_FILTER_PROVIDER ??
        process.env.LLM_PLACE_FILTERS_PROVIDER ??
        process.env.LLM_PLACE_PROVIDER ??
        process.env.LLM_REGION_PROVIDER ??
        'openrouter'
    );
}

function gridFilterLlmModel(): string {
    return (
        process.env.LLM_GRID_FILTER_MODEL ??
        process.env.LLM_PLACE_FILTERS_MODEL ??
        process.env.LLM_PLACE_MODEL ??
        process.env.LLM_REGION_MODEL ??
        'openai/gpt-5.2'
    );
}

async function runGridFilterLlm(
    place: Record<string, unknown>,
    def: AiGridFilterDef,
    lang?: string,
): Promise<{ data: AiGridFilterResult } | { error: string; status: number }> {
    const promptPath = resolvePromptPath('LLM_GRID_FILTER_PROMPT_PATH', 'data/products/places/llm/grid-filter.md');
    const rawMd = await readFile(promptPath, 'utf8');
    const { substitute } = await import('@polymech/commons/variables');
    const vars = buildGridFilterVars(place, def);
    let promptContent = substitute(false, rawMd, vars, true);
    promptContent += languagePromptSuffix(lang);

    const provider = gridFilterLlmProvider();
    const model = gridFilterLlmModel();

    const out = await runLlmJsonCompletion(promptContent, 'kbot-llm-grid-filter', provider, model);
    if ('error' in out) return out;

    const parsed = AiGridFilterResultSchema.safeParse(out.data);
    if (!parsed.success) {
        logger.warn({ err: parsed.error.format(), raw: out.data }, 'grid-filter: invalid LLM JSON shape');
        return { error: 'Invalid LLM response shape', status: 502 };
    }
    const normalizedValue = normalizeAiGridFilterValue(def, parsed.data);
    return { data: { ...parsed.data, value: normalizedValue } };
}

async function mergeLlmGridFilterIntoPlace(
    placeId: string,
    filterId: string,
    entry: {
        value: string | number;
        raw: AiGridFilterResult;
        promptHash: string;
        model: string;
        sourceUserId: string;
    },
): Promise<{ error?: string }> {
    const { data: row, error } = await getPlaceById(placeId);
    if (error || !row) return { error: 'Place not found' };

    const prevMeta =
        row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta) ? { ...(row.meta as Record<string, unknown>) } : {};
    const llmPrev =
        prevMeta.llm_grid_filters && typeof prevMeta.llm_grid_filters === 'object' && !Array.isArray(prevMeta.llm_grid_filters)
            ? { ...(prevMeta.llm_grid_filters as Record<string, unknown>) }
            : {};

    llmPrev[filterId] = {
        value: entry.value,
        raw: entry.raw,
        promptHash: entry.promptHash,
        model: entry.model,
        computedAt: new Date().toISOString(),
        sourceUserId: entry.sourceUserId,
    };
    prevMeta.llm_grid_filters = llmPrev;

    const { error: upErr } = await updatePlaceMeta(placeId, prevMeta);
    if (upErr) return { error: upErr.message || 'Failed to update meta' };
    return {};
}

export type LlmFilterBusPayload = {
    runId: string;
    kind: 'start' | 'skip' | 'cell' | 'error' | 'complete';
    placeId?: string;
    filterId?: string;
    value?: string | number;
    error?: string;
};

const LLM_FILTER_EVENT = 'llm-filter';

async function processLlmFiltersRun(
    runId: string,
    userId: string,
    placeIds: string[],
    filterIds: string[],
    lang?: string,
): Promise<void> {
    /** Let the client open the SSE stream after receiving 202 + runId. */
    await new Promise((r) => setTimeout(r, 150));

    const settings = (await fetchUserSecretsSettingsPg(userId)) as Record<string, unknown>;
    const defs = parseAiGridFilterDefs(settings);
    const defById = new Map(defs.map((d) => [d.id, d]));

    const model = gridFilterLlmModel();

    for (const placeId of placeIds) {
        for (const filterId of filterIds) {
            const def = defById.get(filterId);
            if (!def) {
                EventBus.emit(LLM_FILTER_EVENT, {
                    runId,
                    kind: 'error',
                    placeId,
                    filterId,
                    error: 'Unknown filter id',
                } satisfies LlmFilterBusPayload);
                continue;
            }
            if (def.enabled === false) {
                EventBus.emit(LLM_FILTER_EVENT, { runId, kind: 'skip', placeId, filterId } satisfies LlmFilterBusPayload);
                continue;
            }

            const promptHash = hashGridFilterPrompt(def);

            try {
                const { data: row } = await getPlaceById(placeId);
                if (!row) {
                    EventBus.emit(LLM_FILTER_EVENT, {
                        runId,
                        kind: 'error',
                        placeId,
                        filterId,
                        error: 'Place not found',
                    } satisfies LlmFilterBusPayload);
                    continue;
                }
                const meta = row.meta as Record<string, unknown> | undefined;
                const existing = meta?.llm_grid_filters as Record<string, { promptHash?: string }> | undefined;
                if (existing?.[filterId]?.promptHash === promptHash) {
                    EventBus.emit(LLM_FILTER_EVENT, { runId, kind: 'skip', placeId, filterId } satisfies LlmFilterBusPayload);
                    continue;
                }

                const place = await PlacesLibrary.getPlaceById(placeId);
                const out = await runGridFilterLlm(place as Record<string, unknown>, def, lang);
                if ('error' in out) {
                    EventBus.emit(LLM_FILTER_EVENT, {
                        runId,
                        kind: 'error',
                        placeId,
                        filterId,
                        error: out.error,
                    } satisfies LlmFilterBusPayload);
                    continue;
                }

                const mergeErr = await mergeLlmGridFilterIntoPlace(placeId, filterId, {
                    value: out.data.value,
                    raw: out.data,
                    promptHash,
                    model,
                    sourceUserId: userId,
                });
                if (mergeErr.error) {
                    EventBus.emit(LLM_FILTER_EVENT, {
                        runId,
                        kind: 'error',
                        placeId,
                        filterId,
                        error: mergeErr.error,
                    } satisfies LlmFilterBusPayload);
                    continue;
                }

                EventBus.emit(LLM_FILTER_EVENT, {
                    runId,
                    kind: 'cell',
                    placeId,
                    filterId,
                    value: out.data.value,
                } satisfies LlmFilterBusPayload);
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : 'Unknown error';
                logger.error({ err: e, placeId, filterId }, 'llm grid filter run failed');
                EventBus.emit(LLM_FILTER_EVENT, {
                    runId,
                    kind: 'error',
                    placeId,
                    filterId,
                    error: msg,
                } satisfies LlmFilterBusPayload);
            }
        }
    }

    EventBus.emit(LLM_FILTER_EVENT, { runId, kind: 'complete' } satisfies LlmFilterBusPayload);
}

export async function handlePostLlmFiltersRun(c: any) {
    const userId = await resolveUserIdFromContext(c);
    if (!userId || userId === 'undefined') {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const body = c.req.valid('json') as { placeIds?: string[]; filterIds?: string[]; lang?: string };
    const placeIds = Array.isArray(body.placeIds) ? body.placeIds.map((x) => String(x).trim()).filter(Boolean) : [];
    const filterIds = Array.isArray(body.filterIds) ? body.filterIds.map((x) => String(x).trim()).filter(Boolean) : [];

    if (placeIds.length === 0 || filterIds.length === 0) {
        return c.json({ error: 'placeIds and filterIds required' }, 400);
    }
    if (placeIds.length > 80) {
        return c.json({ error: 'Too many placeIds (max 80)' }, 400);
    }
    if (filterIds.length > 20) {
        return c.json({ error: 'Too many filterIds (max 20)' }, 400);
    }

    const runId = randomUUID();
    EventBus.emit(LLM_FILTER_EVENT, { runId, kind: 'start' } satisfies LlmFilterBusPayload);

    void processLlmFiltersRun(runId, userId, placeIds, filterIds, body.lang).catch((e) => {
        logger.error({ err: e, runId }, 'processLlmFiltersRun failed');
        EventBus.emit(LLM_FILTER_EVENT, {
            runId,
            kind: 'error',
            error: e instanceof Error ? e.message : 'Batch failed',
        } satisfies LlmFilterBusPayload);
        EventBus.emit(LLM_FILTER_EVENT, { runId, kind: 'complete' } satisfies LlmFilterBusPayload);
    });

    return c.json({ data: { runId } }, 202);
}

export async function handleGetLlmFiltersStream(c: any) {
    const userId = await resolveUserIdFromContext(c);
    if (!userId || userId === 'undefined') {
        return c.json({ error: 'Unauthorized' }, 401);
    }

    const { runId } = c.req.valid('query') as { runId: string };
    if (!runId || !String(runId).trim()) {
        return c.json({ error: 'runId required' }, 400);
    }

    return streamSSE(c, async (stream) => {
        let closed = false;
        stream.onAbort(() => {
            closed = true;
        });

        const onLlmFilter = (payload: LlmFilterBusPayload) => {
            if (closed || payload.runId !== runId) return;
            if (payload.kind === 'complete') {
                closed = true;
            }
            void stream
                .writeSSE({
                    event: payload.kind === 'complete' ? 'complete' : 'message',
                    data: JSON.stringify(payload),
                })
                .catch(() => {
                    /* client gone */
                });
        };

        EventBus.on(LLM_FILTER_EVENT, onLlmFilter);

        while (!closed) {
            await new Promise((r) => setTimeout(r, 15000));
            if (closed) break;
            try {
                await stream.writeSSE({ event: 'ping', data: '' });
            } catch {
                closed = true;
            }
        }

        EventBus.off(LLM_FILTER_EVENT, onLlmFilter);
    });
}
