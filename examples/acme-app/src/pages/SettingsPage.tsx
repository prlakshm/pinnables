import { SettingsCard } from "../components/SettingsCard";

export function SettingsPage() {
  return (
    <main className="settings">
      <h1>Settings</h1>
      <section className="settings-panel">
        <SettingsCard />
      </section>
    </main>
  );
}
