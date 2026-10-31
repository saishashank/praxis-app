// Blueprint spec browser (M16 WP7; UXN-300). A server component the Blueprint page mounts as a second
// tab/section. It must be rendered inside the page, which already calls requirePinnedOwner (SEC-111);
// it reads only the repo's allow-listed files and the committed model.
import {
  buildSpecIndex,
  listSpecDocs,
  loadModel,
  renderSpecDoc,
  searchSpecIndex,
} from "@/lib/blueprint/specBrowser";

export type SpecBrowserProps = { doc?: string; q?: string };

export function SpecBrowser({ doc, q = "" }: SpecBrowserProps) {
  const docs = listSpecDocs();
  const shown = doc ? renderSpecDoc(doc) : null;
  const hits = searchSpecIndex(buildSpecIndex(loadModel()), q);
  return (
    <section data-testid="spec-browser" aria-label="Spec browser">
      <nav aria-label="Documents">
        <ul>
          {docs.map((d) => (
            <li key={d.key}>
              <a href={`?tab=spec&doc=${encodeURIComponent(d.key)}`}>{d.title}</a>
            </li>
          ))}
        </ul>
      </nav>
      <form method="get" role="search">
        <input type="hidden" name="tab" value="spec" />
        <label>
          Requirement ID <input type="search" name="q" defaultValue={q} />
        </label>
        <button type="submit">Search</button>
      </form>
      <ul data-testid="spec-index">
        {hits.map((h) => (
          <li key={h.id}>
            <strong>{h.id}</strong>: {h.elements.map((e) => e.name).join(", ")}
          </li>
        ))}
      </ul>
      {shown ? (
        <article
          data-testid="spec-doc"
          // Safe: renderMarkdown HTML-escapes all document text.
          dangerouslySetInnerHTML={{ __html: shown.html }}
        />
      ) : null}
    </section>
  );
}
