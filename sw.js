// Minimal service worker: lets phones install the app ("Add to Home screen"). Always uses the network for data.
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
