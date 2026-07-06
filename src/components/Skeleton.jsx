// Skeleton placeholders shown while lists load.
const arr = (n) => Array.from({ length: n });

export function SkelCards({ n = 4, cols = 4 }) {
  return (
    <div className={`grid cols-${cols}`}>
      {arr(n).map((_, i) => (
        <div key={i} className="panel">
          <div className="skel skel-line" style={{ width: "55%" }} />
          <div className="skel" style={{ height: 30, width: "42%", marginTop: 12 }} />
        </div>
      ))}
    </div>
  );
}

export function SkelPanel({ height = 160 }) {
  return (
    <div className="panel">
      <div className="skel skel-line" style={{ width: "30%", marginBottom: 16 }} />
      <div className="skel" style={{ height }} />
    </div>
  );
}

export function SkelTable({ cols = 5, rows = 7 }) {
  return (
    <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
      <table className="tbl">
        <tbody>
          {arr(rows).map((_, r) => (
            <tr key={r}>
              {arr(cols).map((_, c) => (
                <td key={c}><div className="skel skel-line" style={{ width: c === 0 ? "75%" : `${40 + ((c * 13) % 40)}%` }} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
