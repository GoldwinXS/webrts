// Barrel export for the models module. The renderer imports everything from
// here: ./models.js (the old monolith) has been replaced by ./models/index.js
//
// Import side effects: units.js and buildings.js call registerUnit/registerBuilding
// at module load time, populating the registry. The order matters — core and
// parts must load first, then registry, then the definition files.

// Core: materials, geometry, helpers
export { toonGradient, propToon, SHARED } from "./core.js";

// Registry: makeUnitVisual, makeBuildingVisual, animateVisual, addLamp
export {
  makeUnitVisual, makeBuildingVisual, animateVisual,
  addLamp, registerUnit, registerBuilding,
} from "./registry.js";

// Props: minerals, geysers, shrubs, barriers, watchtowers
export {
  makeMineralVisual, makeGeyserVisual, makeShrubVisual,
  makeTowerVisual, animateTower,
  animateShrub, barrierMaterials,
} from "./props.js";

// Side-effect imports: these register all unit and building models
import "./units.js";
import "./buildings.js";
import "./ooze.js";
import "./storm.js";
