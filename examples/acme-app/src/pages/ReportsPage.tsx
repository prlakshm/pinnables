import { EmptyState } from "../components/EmptyState";

export function ReportsPage() {
  return (
    <main className="reports">
      <h1>Reports</h1>
      <div className="reports-empty-wrapper">
        <EmptyState />
      </div>
    </main>
  );
}
