// Shapes of the architecture model as the page receives it from GET /api/blueprint/model (M16 WP5).
// Types only: the model itself is never imported into a client bundle (D-372).
export type BpView = { id: string; name: string };

export type BpElement = {
  id: string;
  type: string;
  name: string;
  purpose: string;
  specIds: string[];
  owner: string;
  schedule: string | null;
  inputs: string[];
  outputs: string[];
  configKeys: string[];
  tables: string[];
  failure: string;
  runbook: string | null;
  views: string[];
  source: string | null;
  attrs: Record<string, unknown>;
  x?: number;
  y?: number;
};

export type BpEdge = {
  id: string;
  from: string;
  to: string;
  kind: string;
  contract: string;
  views: string[];
};

export type BpModel = {
  schemaVersion: number;
  views: BpView[];
  elements: BpElement[];
  edges: BpEdge[];
};
