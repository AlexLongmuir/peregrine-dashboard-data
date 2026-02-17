diff --git a/src/components/mobile/BottomNav.tsx b/src/components/mobile/BottomNav.tsx
index b14adda..de7785d 100644
--- a/src/components/mobile/BottomNav.tsx
+++ b/src/components/mobile/BottomNav.tsx
@@ -1,281 +1,295 @@
 "use client";
 
-import React, { useState, useEffect } from "react";
+import React, { useCallback, useEffect, useRef, useState } from "react";
+import { usePathname, useRouter } 

[REDACTED]
