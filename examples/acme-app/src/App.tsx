import { NavLink, Route, Routes } from "react-router-dom";
import { DashboardPage } from "./pages/DashboardPage";
import { SettingsPage } from "./pages/SettingsPage";
import { CheckoutPage } from "./pages/CheckoutPage";
import { ReportsPage } from "./pages/ReportsPage";

export function App() {
  return (
    <>
      <nav className="page-nav">
        <NavLink to="/dashboard" className={({ isActive }) => (isActive ? "active" : "")}>
          Dashboard
        </NavLink>
        <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : "")}>
          Settings
        </NavLink>
        <NavLink to="/checkout" className={({ isActive }) => (isActive ? "active" : "")}>
          Checkout
        </NavLink>
        <NavLink to="/reports" className={({ isActive }) => (isActive ? "active" : "")}>
          Reports
        </NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/checkout" element={<CheckoutPage />} />
        <Route path="/reports" element={<ReportsPage />} />
      </Routes>
    </>
  );
}
