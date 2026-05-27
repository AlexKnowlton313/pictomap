import type { RoadClass } from './types';

/**
 * Map a Protomaps `roads` feature to a RoadClass.
 * Schema: https://docs.protomaps.com/basemaps/layers#roads
 *
 * The Protomaps schema uses `kind` for the coarse bucket and `kind_detail`
 * for the OSM `highway=` value. We key off `kind_detail` when available
 * because it preserves runnability-relevant distinctions (motorway vs trunk,
 * footway vs service).
 */
export function classifyRoad(
  props: Record<string, string | number | boolean>,
): RoadClass {
  const detail = String(props.kind_detail ?? '');
  const kind = String(props.kind ?? '');

  switch (detail) {
    case 'motorway':
    case 'motorway_link':
      return 'motorway';
    case 'trunk':
    case 'trunk_link':
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
      return 'path';
    case 'service':
      return 'service';
  }

  switch (kind) {
    case 'highway':
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

/** Hard runnability gate. Soft penalties are applied by the matcher. */
export function isRunnable(klass: RoadClass): boolean {
  return klass !== 'motorway';
}
