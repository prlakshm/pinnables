import { Link } from "react-router-dom";
import { products } from "../data/products";
import { ProductCard } from "../components/ProductCard";

export function HomePage() {
  return (
    <main>
      <section className="hero">
        <h1>Fresh flowers, delivered with care</h1>
        <p>Hand-tied bouquets and seasonal arrangements from our local studio.</p>
        <Link to="/shop" className="btn">
          Shop bouquets
        </Link>
      </section>

      <section className="featured-banner">
        <span className="featured-banner__emoji" aria-hidden>
          💐
        </span>
        <div>
          <h2>Spring collection</h2>
          <p>New peonies and tulips — perfect for Mother's Day and spring celebrations.</p>
        </div>
      </section>

      <section>
        <h2 style={{ marginBottom: "24px", fontSize: "1.75rem" }}>Popular picks</h2>
        <div className="product-grid">
          {products.slice(0, 3).map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
      </section>
    </main>
  );
}
