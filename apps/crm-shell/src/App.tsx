import { Suspense, lazy } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import AppLayout from "./layout/AppLayout";

const Overview = lazy(() => import("./pages/Overview"));
const Board = lazy(() => import("./pages/Board"));
const EntityList = lazy(() => import("./pages/EntityList"));
const RecordDetail = lazy(() => import("./pages/RecordDetail"));
const Agents = lazy(() => import("./pages/Agents"));
const Workflows = lazy(() => import("./pages/Workflows"));
const Approvals = lazy(() => import("./pages/Approvals"));
const Audit = lazy(() => import("./pages/Audit"));
const Setup = lazy(() => import("./pages/Setup"));

function PageFallback() {
  return <div className="text-sm text-text-muted py-10">Loading…</div>;
}

/** The CRM's route table, with the freight pages replaced by pages driven by app.json. */
export default function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Overview />} />
          <Route path="/board" element={<Board />} />
          <Route path="/e/:entity" element={<EntityList />} />
          <Route path="/e/:entity/:id" element={<RecordDetail />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/workflows" element={<Workflows />} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/audit" element={<Audit />} />
          <Route path="/setup" element={<Setup />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
