# PIM Data URL Facets Mapping

Looking at the structure of `PimData.json`, it maps perfectly to the URL facet parameters. The website's backend simply takes the PIM attribute names, lowercases them, and often prefixes them with `item` or adds standard suffixes like `_cm`.

Here is the master mapping of the secret PIM data properties to Lekolar URL `?facet=` parameters:

### 1. Dimensional Properties (Suffix: `_cm`)
*   `Length` → `itemLength_cm`
*   `Width` → `itemWidth_cm`
*   `Height` → `itemHeight_cm`
*   `Depth` → `itemDepth_cm`
*   `Diameter` → `itemDiameter_cm`
*   `SeatHeight` → `itemseatheight_cm`

### 2. Product Attributes (Prefix: `item`)
*   `ItemColorText` → `itemcolortext`
*   `MaterialFurniture` → `itemmaterialfurniture`
*   `LegMaterial` → `itemlegmaterial`
*   `TabletopShape` → `itemtabletopshape`
*   `HeightAdjustable` → `itemheightadjustable`
*   `IsStackable` → `itemisstackable`  *(implied pattern)*

### 3. Color Codes (Suffix: `cvl`)
*   `ColorCodeNCS` → `itemcolorcodencscvl`
*   `ColorCodeRAL` → `itemcolorcoderalcvl`

### 4. Direct Name Matches / Core Filters
*   `EcoLabelling` → `prodecolabelling`
*   `ToxicFreeSymbolsEnhanced` → `toxicfree`
*   `AgeGroups` → `grades`

---

### How we can use this in LekolarEnhancer
Because the PIM data structure exposes exactly how the backend search works, you can build a feature in your extension that dynamically generates deep-links. For example, if you know a product has a specific PIM attribute, you can programmatically construct the filter URL by applying the PIM-to-URL naming rules (e.g. `facet=item${PimKey.toLowerCase()}`).
