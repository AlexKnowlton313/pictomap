import type { RoadClass } from './types';

/**
 * Map a Protomaps `roads` feature to a RoadClass.
 * Schema: https://docs.protomaps.com/basemaps/layers#roads
 *
 * The Protomaps schema uses `kind` for the coarse bucket and `kind_detail`
 * for the OSM `highway=` value. We key off `kind_detail` when available
 * because it preserves runnability-relevant distinctions.
 *
 * Runner-safety rules:
 *   - rail / transit / aerialway / ferry: not roads — hard-blocked here
 *   - construction / proposed / abandoned: not present — hard-blocked here
 *   - motorways and trunks: high-speed, often no shoulder or sidewalk;
 *     kept in the graph but heavily penalized in the matcher so a
 *     parallel surface street wins whenever one exists
 */
export function classifyRoad(
  props: Record<string, string | number | boolean>,
): RoadClass {
  const detail = String(props.kind_detail ?? '');
  const kind = String(props.kind ?? '');

  // Rail / transit / aerialway / ferry. The default Protomaps `roads`
  // layer usually excludes these, but the schema is the author's choice
  // and some builds include rail. Hard-block defensively.
  if (
    kind === 'rail' ||
    kind === 'aerialway' ||
    kind === 'ferry' ||
    kind === 'transit' ||
    detail === 'rail' ||
    detail === 'subway' ||
    detail === 'tram' ||
    detail === 'light_rail' ||
    detail === 'narrow_gauge' ||
    detail === 'monorail' ||
    detail === 'funicular' ||
    detail === 'preserved' ||
    detail === 'miniature' ||
    detail === 'cable_car' ||
    detail === 'gondola' ||
    detail === 'chair_lift' ||
    detail === 'drag_lift' ||
    detail === 'platter' ||
    detail === 't-bar' ||
    detail === 'j-bar' ||
    detail === 'magic_carpet' ||
    detail === 'ferry' ||
    detail === 'shuttle_train'
  ) {
    return 'rail';
  }

  // Not yet (or no longer) a real road on the ground.
  if (
    detail === 'construction' ||
    detail === 'proposed' ||
    detail === 'planned' ||
    detail === 'abandoned' ||
    detail === 'disused' ||
    detail === 'razed' ||
    detail === 'demolished' ||
    detail === 'removed'
  ) {
    return 'unbuilt';
  }

  switch (detail) {
    case 'motorway':
    case 'motorway_link':
    case 'trunk':
    case 'trunk_link':
      return 'motorway';
    case 'primary':
    case 'primary_link':
      return 'major';
    case 'secondary':
    case 'secondary_link':
    case 'tertiary':
    case 'tertiary_link':
    case 'unclassified':
      return 'minor';
    case 'residential':
    case 'living_street':
      return 'residential';
    case 'footway':
    case 'cycleway':
    case 'path':
    case 'pedestrian':
    case 'steps':
    case 'track':
    case 'bridleway':
    case 'corridor':
      return 'path';
    case 'service':
      return 'service';
  }

  switch (kind) {
    case 'highway':
      // Protomaps maps OSM motorway+trunk to `kind=highway`. Anything
      // that lands here is a high-speed road; classify as motorway so the
      // matcher's runnability penalty applies (kept, but discouraged).
      return 'motorway';
    case 'major_road':
      return 'major';
    case 'medium_road':
      return 'minor';
    case 'minor_road':
      return 'residential';
    case 'path':
      return 'path';
  }

  return 'other';
}

/**
 * Hard runnability gate applied at graph build time. Anything `false`
 * here is dropped from the graph entirely — the matcher never sees it.
 * Soft penalties (busy arterials, alleys) are applied in the matcher.
 */
export function isRunnable(klass: RoadClass): boolean {
  return klass !== 'rail' && klass !== 'unbuilt';
}

/**
 * Version of the classification rules / cached-segment schema. Bumped
 * whenever classifyRoad, isRunnable, or the CachedSegment shape change
 * in a way that would make older cached entries wrong. The tile cache
 * includes this in its key, so a bump invalidates stale entries.
 */
export const CLASSIFIER_VERSION = 5;
