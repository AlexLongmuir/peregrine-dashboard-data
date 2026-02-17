diff --git a/src/components/mobile/homepage/NextRaces.tsx b/src/components/mobile/homepage/NextRaces.tsx
index 8e582d3..1b627b9 100644
--- a/src/components/mobile/homepage/NextRaces.tsx
+++ b/src/components/mobile/homepage/NextRaces.tsx
@@ -65,6 +65,17 @@ function trackEvent(event: string, props?: Record<string, unknown>) {
   }
 }
 
+async function loadRacesData(): Promise<Race[]> {
+  if (typeof

[REDACTED]
