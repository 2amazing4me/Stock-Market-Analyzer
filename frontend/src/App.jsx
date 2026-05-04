import { Navigate, Route, Routes } from "react-router-dom";
import HomePage from "./pages/HomePage";
import ScannerPage from "./pages/ScannerPage";
import StockPage from "./pages/StockPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/stock/:ticker" element={<StockPage />} />
      <Route path="/scanner" element={<ScannerPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
