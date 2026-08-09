interface MobileNavProps {
  open?: boolean;
  onClose?: () => void;
}

export function MobileNav({ open = true, onClose }: MobileNavProps) {
  if (!open) return null;

  return (
    <nav className="mobile-nav drawer" data-state="open" aria-label="Main">
      <button type="button" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <a href="/checkout">Checkout</a>
      <a href="/dashboard">Dashboard</a>
      <a href="/settings">Settings</a>
      <a href="/reports">Reports</a>
    </nav>
  );
}
