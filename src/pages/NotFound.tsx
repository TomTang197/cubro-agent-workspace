import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <>
      <div className="page-head"><div><h1>We can't find that page</h1><p className="muted">The link may be out of date, or the address may have a typo.</p></div></div>
      <div className="row gap wrap"><Link className="btn primary" to="/">Go to Overview</Link><Link className="btn" to="/approvals">See what's waiting for approval</Link></div>
    </>
  );
}
