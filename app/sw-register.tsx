"use client";

import { useEffect } from "react";

// Registra el service worker (requisito de instalabilidad PWA). Solo corre en
// contextos seguros (HTTPS o localhost); en HTTP plano de LAN no hay SW y el
// navegador ofrece como mucho un acceso directo.
export function SwRegister() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch(() => {});
    }
  }, []);
  return null;
}
