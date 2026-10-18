import { ShipExportError } from './shipErrors';
import { validateNativeComponents } from './shipNative';
import type { NativeComponent } from './shipNative';
import {
  byteNode,
  float4Node,
  int32Node,
  listNode,
  mapNode,
  nullNode,
  primitive,
  textNode,
  unsetNode
} from './shipTree';
import type { ShipNode } from './shipTree';

/** Explicit neutral ship profile. FormationOrder starts at 0; native field names and
 * primitive encodings are part of the game format and must retain their values. */
export const NEUTRAL_PROFILE_ID = 'ship-lab-07h-neutral-candidate-v1';

export const DEFAULT_SHIP_NAME = 'Armor Export';

export function createPartsNode(components: readonly NativeComponent[]): ShipNode {
  // Empty Parts remains useful for synthetic codec fixtures, though the UI rejects empty ships.
  validateNativeComponents(components, { allowEmpty: true });
  return listNode(components.map(({ nativeId, x, y, rotation, flipX }) => {
    const location = new Uint8Array(8);
    const view = new DataView(location.buffer, location.byteOffset, location.byteLength);
    view.setInt32(0, x, true);
    view.setInt32(4, y, true);
    return mapNode([
      ['FlipX', byteNode(flipX ? 1 : 0)],
      ['ID', textNode(nativeId)],
      ['Location', primitive(location)],
      ['Rotation', int32Node(rotation)],
    ]);
  }));
}

/** Explicit native tree, assembled without reading a saved ship or inheriting its metadata. */
export function createNativeTree(components: readonly NativeComponent[], name = DEFAULT_SHIP_NAME): ShipNode {
  if (typeof name !== 'string' || name.length < 1 || name.length > 64
    || !/^[\x20-\x7e]+$/.test(name) || !/\S/.test(name)) {
    throw new ShipExportError('E_NATIVE_PROFILE', 'Ship name must be short printable ASCII (1–64 bytes).');
  }
  return mapNode([
    ['Author', textNode('')],
    ['BuildCenterlineNESW', nullNode()],
    ['BuildCenterlineNWSE', nullNode()],
    ['BuildCenterlineX', nullNode()],
    ['BuildCenterlineY', nullNode()],
    ['BuildMirrorAxis', int32Node(1)],
    ['BuildMirrorEnabled', byteNode(0)],
    ['CrewSourceRoles', unsetNode()],
    ['CrewSourceTargets', unsetNode()],
    ['Decals1', unsetNode()],
    ['Decals2', unsetNode()],
    ['Decals3', unsetNode()],
    ['DefaultAttackFollowAngle', nullNode()],
    ['DefaultAttackRadius', nullNode()],
    ['DefaultAttackRotation', nullNode()],
    ['Description', textNode('')],
    ['Doors', unsetNode()],
    ['FlightDirection', int32Node(1)],
    ['FormationOrder', int32Node(0)],
    ['Name', textNode(name)],
    ['NewFlexResourceGridTypes', unsetNode()],
    ['PaintCenterlineNESW', nullNode()],
    ['PaintCenterlineNWSE', nullNode()],
    ['PaintCenterlineX', nullNode()],
    ['PaintCenterlineY', nullNode()],
    ['PaintMirrorAxis', int32Node(1)],
    ['PaintMirrorEnabled', byteNode(0)],
    ['PartControlGroups', unsetNode()],
    ['Parts', createPartsNode(components)],
    ['PartUIColorValues', unsetNode()],
    ['PartUIToggleStates', unsetNode()],
    ['ResourceConsumptionToggles', unsetNode()],
    ['ResourceSupplierTargets', unsetNode()],
    ['ResourceSupplyToggles', unsetNode()],
    [
      'Roles',
      listNode([
        mapNode([
          ['AssignmentPriority', int32Node(5)],
          ['AutoFillFromLower', byteNode(0)],
          ['Color', float4Node(1, 1, 1, 1)],
          ['ID', int32Node(-2147483648)],
          ['Name', textNode('Default')],
          ['Priorities', unsetNode()],
        ]),
      ]),
    ],
    ['RoofBaseColor', float4Node(1, 1, 1, 1)],
    ['RoofBaseTexture', textNode('_none_')],
    ['RoofDecalColor1', float4Node(1, 1, 1, 1)],
    ['RoofDecalColor2', float4Node(1, 1, 1, 1)],
    ['RoofDecalColor3', float4Node(1, 1, 1, 1)],
    ['ShipRulesID', textNode('cosmoteer.terran')],
    ['Version', int32Node(3)],
    ['WeaponDirectControlBindings', unsetNode()],
    ['WeaponSelfTargets', unsetNode()],
    ['WeaponShipRelativeTargets', unsetNode()],
  ]);
}
