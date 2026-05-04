import { useNavigate } from "react-router-dom";
import HeaderBar from "../components/HeaderBar";

export default function ScannerPage() {
  const navigate = useNavigate();

  return (
    <main className="tv-page scanner-placeholder">
      <HeaderBar onSearch={(ticker) => navigate(`/stock/${encodeURIComponent(ticker)}`)} />
      <section className="mover-card placeholder-card">
        <h2>Scanner Page</h2>
        <p>This page will be implemented later.</p>
      </section>
    </main>
  );
}
