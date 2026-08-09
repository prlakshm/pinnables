export function CartPage() {
  return (
    <main>
      <h1 style={{ fontSize: "2.25rem", marginBottom: "24px" }}>Your cart</h1>
      <div className="cart-summary">
        <div className="cart-item">
          <span>Garden Roses × 1</span>
          <span>$48</span>
        </div>
        <div className="cart-item">
          <span>Spring Tulips × 1</span>
          <span>$36</span>
        </div>
        <div className="cart-total">
          <span>Total</span>
          <span>$84</span>
        </div>
        <button type="button" className="btn" style={{ width: "100%", marginTop: "20px" }}>
          Checkout
        </button>
      </div>
    </main>
  );
}
