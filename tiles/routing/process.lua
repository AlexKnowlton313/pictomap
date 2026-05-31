-- Tilemaker profile for Pictomap's ROUTING tileset.
--
-- Emits a single `roads` layer containing only *runnable* highways — vehicle
-- roads plus pedestrian paths — and nothing else. Railways, aerialways and
-- ferries live under other OSM keys (`railway=`, `aerialway=`, `route=ferry`)
-- and are never read here, so they're excluded by construction. Not-yet-built
-- ways (construction/proposed) and non-runnable highway values (raceway,
-- busway, bus_guideway, platform, services, rest_area, escape…) are dropped
-- by virtue of not appearing in ROAD_KINDS below.
--
-- Attribute names deliberately mirror the Protomaps basemap `roads` schema so
-- the graph worker consumes these tiles with no code change:
--   * `kind_detail` carries the raw OSM `highway=` value — this is what
--     src/lib/graph/highway.ts switches on first.
--   * `kind` is the coarse Protomaps bucket, used as a fallback there.
--   * `bridge`/`tunnel`/`layer` feed worker.ts `featureLevel` for grade
--     separation (so a bridge isn't merged with the street it crosses).
--
-- Geometry is written at a single zoom (see tiles/routing/config.json) with
-- `high_resolution` extent, which preserves z14-class ground precision while
-- letting the client fetch ~4x fewer tiles.

-- OSM highway= value -> coarse Protomaps `kind`. Membership in this table is
-- also the keep/drop gate: any highway value not present here is skipped.
local ROAD_KINDS = {
  -- High-speed roads. Kept (so the matcher can use them when nothing else
  -- exists) but heavily penalized in matcher.ts; classified as `motorway`.
  motorway = "highway", motorway_link = "highway",
  trunk = "highway",    trunk_link = "highway",
  -- Arterials and collectors.
  primary = "major_road",   primary_link = "major_road",
  secondary = "medium_road", secondary_link = "medium_road",
  tertiary = "medium_road",  tertiary_link = "medium_road",
  unclassified = "medium_road",
  -- Local streets and service roads.
  residential = "minor_road", living_street = "minor_road",
  service = "minor_road",     road = "minor_road",
  -- Pedestrian / cycle / trail network. The whole point of including these:
  -- runnable surfaces the display basemap drops or generalizes away.
  footway = "path", path = "path",       pedestrian = "path",
  steps = "path",   track = "path",      bridleway = "path",
  cycleway = "path", corridor = "path",
}

function node_function()
  -- No point features in the routing tileset.
end

function way_function()
  local highway = Find("highway")
  if highway == "" then return end

  local kind = ROAD_KINDS[highway]
  if kind == nil then return end

  -- false => render as a linestring, not an area. (highway=pedestrian with
  -- area=yes squares would otherwise become polygons; the worker only reads
  -- LineStrings, so keep everything linear.)
  Layer("roads", false)
  Attribute("kind", kind)
  Attribute("kind_detail", highway)

  local bridge = Find("bridge")
  if bridge ~= "" and bridge ~= "no" then Attribute("bridge", "yes") end

  local tunnel = Find("tunnel")
  if tunnel ~= "" and tunnel ~= "no" then Attribute("tunnel", "yes") end

  -- OSM `layer` is the grade-separation level. Pass it through numerically so
  -- featureLevel can read it directly; default 0 (ground) when absent.
  local layer = Find("layer")
  if layer ~= "" then
    local n = tonumber(layer)
    if n ~= nil and n ~= 0 then AttributeNumeric("layer", n) end
  end
end
