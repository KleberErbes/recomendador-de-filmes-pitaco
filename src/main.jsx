import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Pitaco from "./Pitaco.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Pitaco />
  </StrictMode>
);
