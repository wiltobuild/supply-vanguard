// These permissions are also enforced by auth_has_permission() in migrations/0001_auth.up.sql.
export const ROLE_PERMISSIONS = Object.freeze({
  viewer: Object.freeze(['inventory:read']),
  operator: Object.freeze(['inventory:read', 'equipment:write']),
  supply_manager: Object.freeze(['inventory:read', 'supplies:write', 'audit:read', 'audit:export']),
  equipment_manager: Object.freeze(['inventory:read', 'equipment:write', 'equipment:manage', 'audit:read', 'audit:export']),
  admin: Object.freeze(['inventory:read', 'equipment:write', 'equipment:manage', 'supplies:write', 'audit:read', 'audit:export', 'organization:manage', 'membership:manage'])
});

export function permits(role, permission) {
  return Object.hasOwn(ROLE_PERMISSIONS, role) && ROLE_PERMISSIONS[role].includes(permission);
}
