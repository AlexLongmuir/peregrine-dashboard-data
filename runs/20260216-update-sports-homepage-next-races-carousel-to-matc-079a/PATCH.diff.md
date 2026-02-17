diff --git a/src/components/mobile/homepage/NextRaces.tsx b/src/components/mobile/homepage/NextRaces.tsx
index 1d8370b..e1a6689 100644
--- a/src/components/mobile/homepage/NextRaces.tsx
+++ b/src/components/mobile/homepage/NextRaces.tsx
@@ -105,11 +105,38 @@ function SkeletonCard() {
   );
 }
 
+function ChevronIcon({ direction }: { direction: "left" | "right" }) {
+  return (
+    <svg
+      vie

[REDACTED]
