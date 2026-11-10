// praxis-clock: the self-hosted scheduler and job runner (INFRA T3; REQ\infra\INFRA_REQUIREMENT.md §5).
// Plain .mjs entry point (`node clock/index.mjs`, the CMD of Dockerfile.jobs). The TypeScript in clock/ and
// the Worker runners it reuses cannot be run by plain Node (extension-less imports, the "@/" alias), so it is
// bundled first with Vite's SSR build, the same way scripts/arena/engine.mjs bundles the arena engine: into
// node_modules/.cache/ (a tmpfs in the compose file), nothing downloaded, no secret read here.
import { loadEngine } from "../scripts/arena/engine.mjs";

const entry = await loadEngine("clock/main.ts");
await entry.main(process.env);
