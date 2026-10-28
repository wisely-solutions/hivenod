/**
 * The app shell as grey blocks, shown from the first paint until the session and the first data
 * arrive (card CGPynEQY). The very same markup and classes are in index.html, so when React takes
 * over nothing moves. The CSS lives there too, in a <style> that needs no script or stylesheet.
 */
export function AppSkeleton() {
  return (
    <div className="hv-sk" role="status" aria-label="Loading" style={{ display: 'flex' }}>
      <div className="hv-side" />
      <div className="hv-col">
        <div className="hv-head">
          <div className="hv-b" style={{ width: '1.6rem', height: '1.6rem' }} />
          <div className="hv-b" style={{ width: '5rem', height: '1.5rem' }} />
        </div>
        <div className="hv-main">
          <div className="hv-b" style={{ width: '12rem', height: '2.25rem' }} />
          <div className="hv-card" />
          <div className="hv-card" />
          <div className="hv-card" />
        </div>
      </div>
      <div className="hv-tabs">
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}
