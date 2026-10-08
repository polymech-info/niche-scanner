export function fmtMs(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
}

/** Base URL for deep links into the SPA (same as `SERVER_URL` in server `.env`). */
function appBaseUrl(): string {
    return (process.env.SERVER_URL || 'http://localhost:3333').replace(/\/$/, '');
}

function getPlaceId(row: any): string | null {
    const id = row?.place_id ?? row?.placeId ?? row?.id;
    if (id == null || id === '') return null;
    return String(id);
}

function placeDetailHref(placeId: string): string {
    return `${appBaseUrl()}/products/places/detail/${encodeURIComponent(placeId)}`;
}

/** Pipe-escape for markdown table cells. */
function escPipe(s: string | undefined | null): string {
    return String(s ?? '').replace(/\|/g, '\\|');
}

/**
 * Markdown link for a place title (matches `Link` in `useGridColumns` → `/products/places/detail/:placeId`).
 * Safe inside GFM table cells (escapes `|`, `[`, `]`, `\` in the label).
 */
function mdPlaceTitleLink(row: any): string {
    const pid = getPlaceId(row);
    const raw = String(row?.title ?? '');
    if (!pid) return escPipe(raw);
    const label = raw.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    return `[${label}](${placeDetailHref(pid)})`;
}

/** Same link as `mdPlaceTitleLink`, for non-table lines (Issues, lists). */
function mdPlaceTitleLinkInline(row: any): string {
    const pid = getPlaceId(row);
    const raw = String(row?.title ?? '');
    if (!pid) return raw;
    const label = raw.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    return `[${label}](${placeDetailHref(pid)})`;
}

export interface ReportData {
    regionName: string;
    preset: any, //GridSearchPipelineOptions;
    enumResult?: { result?: { areas?: any[]; gridStats?: { validCells: number; skippedCells: number; totalWaypoints: number } } };
    searchResult?: { areas?: any[]; results?: any[]; filtered?: number; apiCalls?: number; freshApiCalls?: number; totalScannedSqKm?: number; areaCount?: number; totalResults?: number; totalPopulation?: number };
    enrichResults: any[];
    timing: { enumMs?: number; searchMs?: number; enrichMs?: number; totalMs?: number };
    totalEmails?: number;
    totalPagesScraped?: number;
    freshApiCalls?: number;
    enumCached?: boolean;
    pipelineName?: string;
    waypointCount?: number;
}

export function generateMdReport(data: ReportData): string {
    const {
        regionName,
        preset,
        enumResult,
        searchResult,
        enrichResults,
        timing,
        totalEmails,
        totalPagesScraped,
        freshApiCalls,
        enumCached,
        pipelineName: pipeName,
    } = data;

    const allResults = (searchResult?.results || []).filter(Boolean);
    const withWebsite = allResults.filter((r: any) => r.website);

    const getEmails = (r: any): string[] => {
        const raw = r.emails || r.meta?.emails;
        if (!Array.isArray(raw)) return [];
        return raw.map((e: any) => typeof e === 'object' && e ? (e.email || e.toString()) : String(e)).filter(Boolean);
    };

    const getPagesCount = (r: any): number => {
        const pages = r.meta?.pages || r.pages;
        return Array.isArray(pages) ? pages.length : 0;
    };

    const withEmails = enrichResults.filter((r: any) => getEmails(r).length > 0);

    const calculatedTotalEmails = enrichResults.reduce((acc: number, r: any) => acc + getEmails(r).length, 0);
    const finalTotalEmails = Math.max(totalEmails ?? 0, calculatedTotalEmails);

    const calculatedTotalPages = enrichResults.reduce((acc: number, r: any) => acc + getPagesCount(r), 0);
    const finalTotalPages = Math.max(totalPagesScraped ?? 0, calculatedTotalPages);

    const lines: string[] = [
        `# GridSearch${pipeName ? ': ' + pipeName : ''}: ${regionName}`,
        '',
        `> Generated ${new Date().toISOString()}`,
        '',
        '## Pipeline Summary',
        '',
        '| Metric | Value |',
        '|--------|-------|',
        `| Region | ${regionName} |`,
        `| Query | ${(preset?.search?.types || preset?.types || []).join(', ')} |`,
    ];

    if (preset?.guided) {
        lines.push(`| Cell size | ${preset.guided.settings?.cellSize} km |`);
        lines.push(`| Grid mode | ${preset.guided.settings?.gridMode} |`);
        lines.push(`| Areas selected | ${preset.guided.areas?.length} |`);
        const gs = enumResult?.result?.gridStats;
        if (gs) {
            lines.push(`| Pop centers (valid) | ${gs.validCells} |`);
            lines.push(`| Pop centers (skipped) | ${gs.skippedCells} |`);
        }
    }
    const limitPerArea = preset?.search?.limitPerArea ?? preset?.limitPerArea;
    if (limitPerArea != null) {
        lines.push(`| Limit/area | ${limitPerArea} |`);
    }

    lines.push(
        `| Waypoints generated | ${data.waypointCount ?? enumResult?.result?.areas?.length ?? '—'} |`,
        `| API calls | ${searchResult?.apiCalls ?? freshApiCalls ?? '—'} |`,
        `| Google domain | ${preset?.search?.googleDomain || preset?.googleDomain || '—'} |`,
        `| Filter country | ${preset?.search?.filterCountry || preset?.filterCountry || '—'} |`,
    );

    const filterTypeIds = preset?.search?.filterTypeIds || preset?.filterTypeIds;
    if (filterTypeIds?.length) {
        lines.push(`| Filter type_ids | ${filterTypeIds.join(', ')} |`);
    }
    const excludeTypes = preset?.excludeTypes || preset?.search?.excludeTypes;
    if (excludeTypes?.length) {
        lines.push(`| Exclude types | ${excludeTypes.join(', ')} |`);
    }
    if (searchResult?.filtered != null) {
        lines.push(`| Results filtered out | ${searchResult.filtered} |`);
    }
    if (searchResult?.totalScannedSqKm != null) {
        lines.push(`| **Total area scanned** | **${Math.round(searchResult.totalScannedSqKm)} km²** |`);
    }
    if (searchResult?.totalPopulation != null && searchResult.totalPopulation > 0) {
        lines.push(`| **Total population** | **${Math.round(searchResult.totalPopulation).toLocaleString('en-US')}** |`);
    }

    lines.push(
        `| Total search results | ${allResults.length || searchResult?.totalResults || 0} |`,
        `| Results with website | ${withWebsite.length} |`,
        `| Locations with emails | ${withEmails.length} |`,
        `| Total emails found | ${finalTotalEmails} |`,
        `| Total pages scraped | ${finalTotalPages} |`,
        '',
    );

    // Cache summary (if search result has per-area data)
    const searchAreas = searchResult?.areas;
    if (searchAreas?.length) {
        const cachedAreas = searchAreas.filter((a: any) => a.cached).length;
        const enrichCacheHits = enrichResults.filter((r: any) => r.fromCache === true).length;
        lines.push(
            '## Cache Summary',
            '',
            '| Phase | Total | ♻ Cached | 🌐 Fresh |',
            '|-------|-------|---------|---------|',
            `| Phase 1 — Enumeration | 1 | ${enumCached ? 1 : 0} | ${enumCached ? 0 : 1} |`,
            `| Phase 2 — Areas | ${searchAreas.length} | ${cachedAreas} | ${searchResult?.freshApiCalls ?? searchAreas.length - cachedAreas} |`,
            `| Phase 3 — Enrichment | ${enrichResults.length} | ${enrichCacheHits} | ${enrichResults.length - enrichCacheHits} |`,
            '',
        );
    }

    // Timing
    lines.push(
        '## Timing',
        '',
        '| Phase | Duration |',
        '|-------|----------|',
        `| Grid resolution | ${fmtMs(timing.enumMs ?? 0)}${enumCached ? ' ♻️' : ''} |`,
        `| Grid search | ${fmtMs(timing.searchMs ?? 0)} |`,
        `| Enrichment | ${fmtMs(timing.enrichMs ?? 0)} |`,
        `| **Total** | **${fmtMs(timing.totalMs ?? 0)}** |`,
        '',
    );

    // Enrichment Results table
    if (enrichResults.length > 0) {
        lines.push('## Enrichment Results', '');
        // If full enrichment detail available (metaMs etc), show detailed table
        const hasDetail = enrichResults[0]?.metaMs != null;
        const getTypes = (r: any): string => {
            const t = r.types || [];
            return Array.isArray(t) ? t.join(', ') : String(t || '');
        };
        if (hasDetail) {
            lines.push('| ♻ | Title | Address | Types | Website | Pages | Scraped | Meta | Email | Total |');
            lines.push('|----|-------|---------|-------|---------|-------|---------|------|-------|-------|');
            for (const r of enrichResults) {
                const cacheIcon = r.fromCache ? '♻️' : '';
                lines.push(`| ${cacheIcon} | ${mdPlaceTitleLink(r)} | ${escPipe(r.address)} | ${escPipe(getTypes(r))} | ${escPipe(r.website)} | ${r.pagesFound ?? ''} | ${r.pagesScraped ?? ''} | ${fmtMs(r.metaMs)} | ${fmtMs(r.emailMs)} | ${fmtMs(r.totalMs)} |`);
            }
        } else {
            lines.push('| Title | Address | Types | Website |');
            lines.push('|-------|---------|-------|---------|');
            for (const r of enrichResults) {
                lines.push(`| ${mdPlaceTitleLink(r)} | ${escPipe(r.address)} | ${escPipe(getTypes(r))} | ${escPipe(r.website)} |`);
            }
        }
        lines.push('');
    }

    // Email Directory
    if (withEmails.length > 0) {
        lines.push('## 📧 Email Directory', '');
        lines.push('| # | Email | Company | Grid Area | Address | Website |');
        lines.push('|---|-------|---------|-----------|---------|---------|');
        let emailIdx = 0;
        for (const r of withEmails) {
            const emailsList = getEmails(r);
            for (const email of emailsList) {
                emailIdx++;
                lines.push(`| ${emailIdx} | ${email} | ${mdPlaceTitleLink(r)} | ${escPipe(r.gridArea)} | ${escPipe(r.address)} | ${escPipe(r.website)} |`);
            }
        }
        lines.push('');
    }

    // Issues
    const failures = enrichResults.filter((r: any) => r.status === 'ERROR');
    const timeouts = enrichResults.filter((r: any) => r.status === 'META_TIMEOUT' || r.status === 'EMAIL_TIMEOUT');
    if (failures.length > 0 || timeouts.length > 0) {
        lines.push('## ⚠ Issues', '');
        if (timeouts.length > 0) {
            lines.push(`**Timeouts (${timeouts.length}):** ${timeouts.map((r: any) => `${mdPlaceTitleLinkInline(r)} (${r.status})`).join(', ')}`, '');
        }
        if (failures.length > 0) {
            lines.push(`**Errors (${failures.length}):**`);
            for (const r of failures) lines.push(`- ${mdPlaceTitleLinkInline(r)}: ${r.error}`);
            lines.push('');
        }
    }

    // Site Errors
    const withFetchError = enrichResults.filter((r: any) => r.fetchError);
    const withBadHttp = enrichResults.filter((r: any) => r.httpStatus && r.httpStatus >= 400);
    const allPageErrors = enrichResults.flatMap((r: any) =>
        (r.pageErrors || [])
            .filter((pe: any) => pe.status === 'FAILED')
            .map((pe: any) => ({ ...pe, locationTitle: r.title, locationPlaceId: getPlaceId(r) }))
    );

    if (withFetchError.length > 0 || withBadHttp.length > 0 || allPageErrors.length > 0) {
        lines.push('## 🔴 Site Errors', '');
        if (withFetchError.length > 0) {
            lines.push(`### Fetch Errors (${withFetchError.length})`, '', '| Title | HTTP | Error |', '|-------|------|-------|');
            for (const r of withFetchError) lines.push(`| ${mdPlaceTitleLink(r)} | ${r.httpStatus ?? '—'} | ${escPipe(r.fetchError!.substring(0, 80))} |`);
            lines.push('');
        }
        if (withBadHttp.length > 0) {
            lines.push(`### Non-OK HTTP Status (${withBadHttp.length})`, '');
            for (const r of withBadHttp) lines.push(`- **${r.httpStatus}** — ${mdPlaceTitleLinkInline(r)} (${r.website})`);
            lines.push('');
        }
        if (allPageErrors.length > 0) {
            lines.push(`### Page-Level Failures (${allPageErrors.length})`, '', '| Location | URL | HTTP | Error |', '|----------|-----|------|-------|');
            for (const pe of allPageErrors.slice(0, 30)) {
                const loc = mdPlaceTitleLink({ title: pe.locationTitle, place_id: pe.locationPlaceId });
                lines.push(`| ${loc} | ${escPipe(pe.url)} | ${pe.httpStatus ?? '—'} | ${escPipe((pe.error || '').substring(0, 60))} |`);
            }
            if (allPageErrors.length > 30) lines.push(`| ... | _${allPageErrors.length - 30} more_ | | |`);
            lines.push('');
        }
    }

    // Page Details
    const resultsWithPages = enrichResults.filter((r: any) => r.pageErrors?.length > 0);
    if (resultsWithPages.length > 0) {
        lines.push('## 📄 Page Details', '');
        for (const r of resultsWithPages) {
            lines.push(`### ${mdPlaceTitleLinkInline(r)}`, '', '| URL | Method | Status | HTTP | Emails |', '|-----|--------|--------|------|--------|');
            for (const pe of r.pageErrors) {
                const peEmails = Array.isArray(pe.emails) ? pe.emails.map((e: any) => typeof e === 'object' && e ? e.email : e) : [];
                const emailStr = peEmails.length ? peEmails.join(', ') : '—';
                lines.push(`| ${escPipe(pe.url)} | ${pe.method || '—'} | ${pe.status} | ${pe.httpStatus ?? '—'} | ${emailStr} |`);
            }
            lines.push('');
        }
    }

    return lines.join('\n');
}

export function generateJsonReport(data: ReportData): object {
    const {
        regionName,
        preset,
        enumResult,
        searchResult,
        enrichResults,
        timing,
        totalEmails,
        totalPagesScraped,
        pipelineName: pipeName,
    } = data;

    const allResults = (searchResult?.results || []).filter(Boolean);
    const withWebsite = allResults.filter((r: any) => r.website);

    const getEmails = (r: any): string[] => {
        const raw = r.emails || r.meta?.emails;
        if (!Array.isArray(raw)) return [];
        return raw.map((e: any) => typeof e === 'object' && e ? (e.email || e.toString()) : String(e)).filter(Boolean);
    };

    const getPagesCount = (r: any): number => {
        const pages = r.meta?.pages || r.pages;
        return Array.isArray(pages) ? pages.length : 0;
    };

    const withEmails = enrichResults.filter((r: any) => getEmails(r).length > 0);

    const calculatedTotalEmails = enrichResults.reduce((acc: number, r: any) => acc + getEmails(r).length, 0);
    const finalTotalEmails = Math.max(totalEmails ?? 0, calculatedTotalEmails);

    const calculatedTotalPages = enrichResults.reduce((acc: number, r: any) => acc + getPagesCount(r), 0);
    const finalTotalPages = Math.max(totalPagesScraped ?? 0, calculatedTotalPages);

    const searchAreas = searchResult?.areas;

    return {
        generatedAt: new Date().toISOString(),
        pipeline: pipeName ?? regionName,
        config: {
            region: regionName,
            ...(preset.guided && {
                areas: preset.guided.areas.map((a: any) => ({ gid: a.gid, name: a.name })),
                settings: preset.guided.settings,
            }),
            ...(!preset?.guided && preset?.enumerate && { level: preset.enumerate.level }),
            search: preset?.search || {
                types: preset?.types || [],
                limitPerArea: preset?.limitPerArea,
                googleDomain: preset?.googleDomain,
                filterCountry: preset?.filterCountry,
                language: preset?.language,
                zoom: preset?.zoom,
            },
            ...((preset?.excludeTypes?.length || preset?.search?.excludeTypes?.length) && {
                excludeTypes: preset?.excludeTypes || preset?.search?.excludeTypes,
            }),
        },
        grid: {
            areasSelected: preset.guided?.areas.length ?? enumResult?.result?.areas?.length ?? 0,
            waypointsGenerated: enumResult?.result?.areas?.length ?? 0,
            ...(searchAreas && {
                areasWithResults: searchAreas.filter((a: any) => a.results?.length > 0).length,
            }),
        },
        search: {
            serpApiCalls: searchResult?.apiCalls ?? data.freshApiCalls ?? 0,
            totalLocations: allResults.length,
            withWebsite: withWebsite.length,
            ...(searchResult?.totalScannedSqKm != null && { totalScannedSqKm: searchResult.totalScannedSqKm }),
            ...(searchResult?.totalPopulation != null && { totalPopulation: searchResult.totalPopulation }),
            ...(searchResult?.filtered != null && { filteredOut: searchResult.filtered }),
            foundTypes: [...new Set(allResults.flatMap((r: any) => r.types || []).filter(Boolean))],
        },
        enrichment: {
            locationsProcessed: enrichResults.length,
            locationsWithEmail: withEmails.length,
            totalEmailsFound: finalTotalEmails,
            totalPagesScraped: finalTotalPages,
            byStatus: Object.fromEntries(
                ['OK', 'NO_EMAIL', 'META_TIMEOUT', 'EMAIL_TIMEOUT', 'FETCH_ERROR', 'NO_PAGES', 'ERROR']
                    .map(s => [s, enrichResults.filter((r: any) => r.status === s).length] as const)
                    .filter(([, v]) => v > 0)
            ),
        },
        timing,
        emails: withEmails.map((r: any) => {
            const pid = getPlaceId(r);
            return {
                email: getEmails(r),
                title: r.title,
                website: r.website,
                gridArea: r.gridArea,
                address: r.address,
                ...(pid ? { detailUrl: placeDetailHref(pid) } : {}),
            };
        }),
    };
}
