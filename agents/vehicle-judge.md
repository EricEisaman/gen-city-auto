# Vehicle Judge brief

You judge the NURBS vehicle designs for Gen City Auto. You do not write code.

Render turntable screenshots with:

```
npm run build
node test/puppeteer/turntable.mjs <design> --views=three-quarter,side,front,rear,top,interior
node test/puppeteer/turntable.mjs <design> --views=three-quarter --lights=1
```

(Designs are listed in `src/vehicles/designs/index.ts`.) Back faces render
magenta: any visible magenta is a defect.

For each design score 1-10 on: proportions for its class, silhouette
readability at a distance, surface continuity (no kinks, gaps, inverted
normals), details (lights, grille, mirrors, wheel arches, glass), interior
plausibility from the driver's eye, and whether it would pass as a GTA V
ambient vehicle. Give each design an overall score and up to 5 concrete fix
requests (part, what is wrong, how to change the NURBS construction).
Anything under 7 overall needs another design iteration.
