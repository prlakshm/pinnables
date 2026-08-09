import { useState } from "react";
import { MobileNav } from "../components/MobileNav";

export function CheckoutPage() {
  const [navOpen, setNavOpen] = useState(true);

  return (
    <div className="checkout-layout">
      <MobileNav open={navOpen} onClose={() => setNavOpen(false)} />
      <main className="checkout-content">
        <h1>Checkout</h1>
        <p>Slide-in drawer navigation — not a bottom tab bar.</p>
        {!navOpen && (
          <button type="button" onClick={() => setNavOpen(true)}>
            Open menu
          </button>
        )}
      </main>
    </div>
  );
}
