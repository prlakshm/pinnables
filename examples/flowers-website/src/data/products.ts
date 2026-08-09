export interface Product {
  id: string;
  name: string;
  description: string;
  price: number;
  emoji: string;
}

export const products: Product[] = [
  { id: "roses", name: "Garden Roses", description: "A dozen blush pink roses", price: 48, emoji: "🌹" },
  { id: "tulips", name: "Spring Tulips", description: "Mixed pastel bouquet", price: 36, emoji: "🌷" },
  { id: "sunflowers", name: "Sunflower Bundle", description: "Bright and cheerful", price: 32, emoji: "🌻" },
  { id: "lilies", name: "White Lilies", description: "Elegant and fragrant", price: 42, emoji: "💮" },
  { id: "peonies", name: "Peony Arrangement", description: "Seasonal favorite", price: 55, emoji: "🌸" },
  { id: "orchids", name: "Orchid Plant", description: "Long-lasting gift", price: 68, emoji: "🪻" },
];
