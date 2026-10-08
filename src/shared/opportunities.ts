import type { ProductMatch } from "./capabilities.js";
import type {
  Locale,
  PhraseRecord,
  SearchError,
  SerpCallMeta,
  SerpLandscape,
} from "./phrases.js";

export type OpportunityStatus = "ready" | "promoted";

export interface OpportunityBudget {
  requested: number;
  planned: number;
  attempted: number;
}

export interface OpportunityCandidate {
  phrase: string;
  record: PhraseRecord;
  productMatch: ProductMatch;
  rank: number;
}

export interface OpportunityRun {
  id: string;
  status: OpportunityStatus;
  query: string;
  createdAt: string;
  expiresAt: string;
  locale: Locale;
  productMatch: ProductMatch;
  variations: string[];
  candidates: OpportunityCandidate[];
  landscape: SerpLandscape[];
  calls: SerpCallMeta[];
  errors: SearchError[];
  budget: OpportunityBudget;
}

export interface CreateOpportunityInput {
  query: string;
  locale?: Partial<Locale>;
  /** Maximum paid SerpAPI calls. Normalized to the supported 2-call steps. */
  serpBudget?: number;
}

export interface PromoteOpportunityInput {
  phrases: string[];
  name?: string;
  targetSearchId?: string;
}
