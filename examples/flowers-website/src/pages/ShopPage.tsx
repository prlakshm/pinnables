import { products } from "../data/products";
import { ProductCard } from "../components/ProductCard";

export function ShopPage() {
  return (
    <main>
      <h1 style={{ fontSize: "2.25rem", marginBottom: "8px" }}>Shop</h1>
      <p style={{ color: "var(--color-text-muted)", marginBottom: "32px" }}>
        All bouquets include a handwritten note.
      </p>
      <div className="product-grid">
        {products.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
    </main>
  );
}
