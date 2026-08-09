import { StatCard } from "../components/StatCard";
import { ActivityCard } from "../components/ActivityCard";

export function DashboardPage() {
  return (
    <main className="dashboard">
      <h1>Dashboard</h1>
      <section className="dashboard-grid">
        <StatCard />
        <ActivityCard />
      </section>
    </main>
  );
}
