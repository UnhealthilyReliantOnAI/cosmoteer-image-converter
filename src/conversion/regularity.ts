import { getPlacedPolygon } from '../construction/model';
import type { Construction, PiecePlacement } from '../construction/model';
import { placementKey } from '../construction/symmetry';
import type { Point } from '../geometry/polygon';
import { boundaryMask, rasterizeComparison } from './diagnostics';
import type { CoverageTarget } from './target';

interface Edge {
  readonly key: string;
  readonly a: Point;
  readonly b: Point;
  readonly aKey: string;
  readonly bKey: string;
  readonly length: number;
}

/** Weights of exposed perimeter and source-unsupported bends in the smoothing objective. */
const PERIMETER_WEIGHT = 0.12;

const UNSUPPORTED_BEND_WEIGHT = 0.22;

const pointKey = ({ x, y }: Point) => `${x},${y}`;

/** Only axial edges can be shared by disjoint reserved cells. Half-cell atoms handle partial contacts. */
function pieceEdges(piece: PiecePlacement): Edge[] {
  const polygon = getPlacedPolygon(piece);
  const result: Edge[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const start = polygon[i]!, end = polygon[(i + 1) % polygon.length]!;
    const steps = start.x === end.x || start.y === end.y ? Math.round(2 * Math.hypot(end.x - start.x, end.y - start.y)) : 1;
    for (let step = 0; step < steps; step++) {
      const a = {
        x: start.x + (end.x - start.x) * step / steps,
        y: start.y + (end.y - start.y) * step / steps,
      };
      const b = {
        x: start.x + (end.x - start.x) * (step + 1) / steps,
        y: start.y + (end.y - start.y) * (step + 1) / steps,
      };
      const aKey = pointKey(a), bKey = pointKey(b);
      result.push({
        key: [aKey, bKey].sort().join(';'),
        a,
        b,
        aKey,
        bKey,
        length: Math.hypot(b.x - a.x, b.y - a.y),
      });
    }
  }
  return result;
}

export interface ContourRegularity {
  readonly perimeter: number;
  /** Sum of 1-cos(turn). A straight continuation costs zero, a sharp reversal approaches two. */
  readonly bendEnergy: number;
  readonly unsupportedBendEnergy: number;
  readonly corners: number;
  readonly pointJunctions: number;
}

/** Protect source corners: covariance of nearby SOURCE boundary samples, never the converted pieces.
 * A corner has two different directions; a locally straight/smooth edge has a low minor eigenvalue.
 * Support applies only within 0.2 cell of the source contour, excluding invented notches in solid material.
 */
function sourceCornerSupport(target: CoverageTarget, checkpoint: () => void): (point: Point) => number {
  const raster = rasterizeComparison(target, { width: target.width, height: target.height, pieces: [] }, 12, checkpoint);
  const { width, height, target: data } = raster;
  const boundary = boundaryMask(data, width, height);
  const cache = new Map<string, number>();
  return (point) => {
    const key = pointKey(point);
    const old = cache.get(key);
    if (old !== undefined) return old;
    let n = 0, sx = 0, sy = 0, xx = 0, yy = 0, xy = 0, nearest = Infinity;
    const radius = 1.15;
    for (let y = Math.max(0, Math.floor((point.y - radius) * 12)); y < Math.min(height, Math.ceil((point.y + radius) * 12)); y++) {
      for (let x = Math.max(0, Math.floor((point.x - radius) * 12)); x < Math.min(width, Math.ceil((point.x + radius) * 12)); x++) {
        if (!boundary[y * width + x]) continue;
        const dx = (x + 0.5) / 12 - point.x, dy = (y + 0.5) / 12 - point.y;
        const distance = Math.hypot(dx, dy);
        if (distance > radius) continue;
        nearest = Math.min(nearest, distance);
        n++;
        sx += dx;
        sy += dy;
        xx += dx * dx;
        yy += dy * dy;
        xy += dx * dy;
      }
    }
    let support = 0;
    if (n >= 4 && nearest < 0.2) {
      const vx = xx / n - (sx / n) ** 2, vy = yy / n - (sy / n) ** 2, cov = xy / n - sx * sy / n ** 2;
      const root = Math.sqrt((vx - vy) ** 2 + 4 * cov ** 2);
      const ratio = (vx + vy - root) / Math.max(1e-8, vx + vy + root);
      support = Math.max(0, Math.min(1, (ratio - 0.025) / 0.12));
    }
    cache.set(key, support);
    return support;
  };
}

/** Incremental exact exposed polygon boundary. No SVG/raster smoothing is involved. */
export class ContourGraph {
  // A placement appears in many local proposals. Its atoms never change.
  // Scope the cache to this graph; include coordinates/orientation, not IDs or mutable object identity.
  private readonly atomsByPlacement = new Map<string, readonly Edge[]>();
  private readonly edges = new Map<string, {
    edge: Edge;
    count: number;
  }>();
  private readonly vertices = new Map<string, {
    point: Point;
    edges: Map<string, Edge>;
  }>();
  private perimeter = 0;
  private bends = 0;
  private unsupported = 0;
  private corners = 0;
  private junctions = 0;
  constructor(private readonly support: (point: Point) => number = () => 0) {}
  private vertexMetric(key: string, vertex = this.vertices.get(key)):
  {
    bend: number;
    unsupported: number;
    corner: number;
    junction: number;
  } {
    if (!vertex || vertex.edges.size < 2) return { bend: 0, unsupported: 0, corner: 0, junction: 0 };
    if (vertex.edges.size !== 2) return { bend: 2, unsupported: 2, corner: 0, junction: 1 };
    const vectors = [...vertex.edges.values()].map((edge) => {
      const other = edge.aKey === key ? edge.b : edge.a;
      return {
        x: (other.x - vertex.point.x) / edge.length,
        y: (other.y - vertex.point.y) / edge.length,
      };
    });
    const bend = Math.max(0, 1 + vectors[0]!.x * vectors[1]!.x + vectors[0]!.y * vectors[1]!.y);
    return {
      bend,
      unsupported: bend < 1e-8 ? 0 : bend * (1 - this.support(vertex.point)),
      corner: bend > 1e-8 ? 1 : 0,
      junction: 0,
    };
  }

  /** Local penalty difference. Rejected exchanges leave counts, vertices and totals untouched.
   * Placement atoms/support may be cached; their geometry is immutable within this graph.
   * Keep the summation order stable: roundoff can affect the acceptance of tied proposals.
   */
  evaluateExchange(removed: readonly PiecePlacement[], added: readonly PiecePlacement[]): number {
    const differences = new Map<string, {
      edge: Edge;
      count: number;
    }>();
    const collect = (pieces: readonly PiecePlacement[], sign: 1 | -1) => {
      for (const piece of pieces) {
        const key = placementKey(piece);
        let atoms = this.atomsByPlacement.get(key);
        if (!atoms) {
          atoms = pieceEdges(piece);
          this.atomsByPlacement.set(key, atoms);
        }
        for (const edge of atoms) {
          const old = differences.get(edge.key);
          if (old) old.count += sign;
          else differences.set(edge.key, { edge, count: sign });
        }
      }
    };
    collect(removed, -1);
    collect(added, 1);
    const affected = new Map<string, {
      point: Point;
      edges: Map<string, Edge>;
    }>();
    const endpoint = (key: string, point: Point, edge: Edge, visible: boolean) => {
      let vertex = affected.get(key);
      if (!vertex) {
        const old = this.vertices.get(key);
        vertex = { point: old?.point ?? point, edges: new Map(old?.edges) };
        affected.set(key, vertex);
      }
      if (visible) vertex.edges.set(edge.key, edge);
      else vertex.edges.delete(edge.key);
    };
    let perimeterDelta = 0;
    for (const { edge, count } of differences.values()) {
      if (count === 0) continue;
      const previous = this.edges.get(edge.key)?.count ?? 0;
      const visible = previous + count === 1;
      if (visible === (previous === 1)) continue;
      perimeterDelta += (visible ? 1 : -1) * edge.length;
      endpoint(edge.aKey, edge.a, edge, visible);
      endpoint(edge.bKey, edge.b, edge, visible);
    }
    let unsupportedDelta = 0;
    for (const [key, vertex] of affected) {
      unsupportedDelta += this.vertexMetric(key, vertex).unsupported - this.vertexMetric(key).unsupported;
    }
    return PERIMETER_WEIGHT * perimeterDelta + UNSUPPORTED_BEND_WEIGHT * unsupportedDelta;
  }
  change(pieces: readonly PiecePlacement[], sign: 1 | -1): void {
    const atoms: Edge[] = [];
    const touched = new Set<string>();
    for (const piece of pieces) {
      const key = placementKey(piece);
      let cached = this.atomsByPlacement.get(key);
      if (!cached) {
        cached = pieceEdges(piece);
        this.atomsByPlacement.set(key, cached);
      }
      for (const edge of cached) {
        atoms.push(edge);
        touched.add(edge.aKey);
        touched.add(edge.bKey);
      }
    }
    for (const key of touched) {
      const m = this.vertexMetric(key);
      this.bends -= m.bend;
      this.unsupported -= m.unsupported;
      this.corners -= m.corner;
      this.junctions -= m.junction;
    }
    const expose = (edge: Edge, visible: boolean) => {
      this.perimeter += (visible ? 1 : -1) * edge.length;
      this.exposeEndpoint(edge.aKey, edge.a, edge, visible);
      this.exposeEndpoint(edge.bKey, edge.b, edge, visible);
    };
    for (const edge of atoms) {
      const previous = this.edges.get(edge.key)?.count ?? 0;
      if (previous === 1) expose(edge, false);
      const next = previous + sign;
      if (next === 0) this.edges.delete(edge.key);
      else this.edges.set(edge.key, { edge, count: next });
      if (next === 1) expose(edge, true);
    }
    for (const key of touched) {
      const m = this.vertexMetric(key);
      this.bends += m.bend;
      this.unsupported += m.unsupported;
      this.corners += m.corner;
      this.junctions += m.junction;
    }
  }
  private exposeEndpoint(key: string, point: Point, edge: Edge, visible: boolean): void {
    let vertex = this.vertices.get(key);
    if (!vertex) {
      vertex = { point, edges: new Map() };
      this.vertices.set(key, vertex);
    }
    if (visible) vertex.edges.set(edge.key, edge);
    else vertex.edges.delete(edge.key);
    if (vertex.edges.size === 0) this.vertices.delete(key);
  }
  measure(): ContourRegularity {
    return {
      perimeter: this.perimeter,
      bendEnergy: this.bends,
      unsupportedBendEnergy: this.unsupported,
      corners: this.corners,
      pointJunctions: this.junctions,
    };
  }
  penalty(): number {
    return PERIMETER_WEIGHT * this.perimeter + UNSUPPORTED_BEND_WEIGHT * this.unsupported;
  }
}

export function createContourGraph(target: CoverageTarget, construction: Construction, checkpoint: () => void): ContourGraph {
  const graph = new ContourGraph(sourceCornerSupport(target, checkpoint));
  graph.change(construction.pieces, 1);
  return graph;
}

export function measureRegularity(construction: Construction): ContourRegularity {
  const graph = new ContourGraph();
  graph.change(construction.pieces, 1);
  return graph.measure();
}
