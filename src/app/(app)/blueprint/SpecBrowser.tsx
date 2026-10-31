// Blueprint spec browser (M16 WP7; UXN-300). A server component the Blueprint page mounts as a second
// tab/section. It must be rendered inside the page, which already calls requirePinnedOwner (SEC-111);
// it reads only the repo's allow-listed files and the committed model.
import {
  buildSpecIndex,
  listSpecDocs,
  loadModel,
  renderSpecDoc,
  searchSpecIndex,
  type Block,
  type Inline,
} from "@/lib/blueprint/specBrowser";

function Inl({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.k === "code" ? (
          <code key={i}>{p.s}</code>
        ) : p.k === "strong" ? (
          <strong key={i}>{p.s}</strong>
        ) : (
          <span key={i}>{p.s}</span>
        ),
      )}
    </>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "h": {
            const H = `h${b.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
            return (
              <H key={i}>
                <Inl parts={b.inl} />
              </H>
            );
          }
          case "p":
            return (
              <p key={i}>
                <Inl parts={b.inl} />
              </p>
            );
          case "code":
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            return (
              <L key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inl parts={it} />
                  </li>
                ))}
              </L>
            );
          }
          case "table":
            return (
              <table key={i}>
                <thead>
                  <tr>
                    {b.head.map((c, j) => (
                      <th key={j}>
                        <Inl parts={c} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((c, k) => (
                        <td key={k}>
                          <Inl parts={c} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
        }
      })}
    </>
  );
}

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
              <a href={`/blueprint?tab=spec&doc=${encodeURIComponent(d.key)}`}>{d.title}</a>
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
        <article data-testid="spec-doc">
          <Blocks blocks={shown.blocks} />
        </article>
      ) : null}
    </section>
  );
}
