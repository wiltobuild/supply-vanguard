import {recoveryTables} from './recovery-inventory.mjs';

// PostgreSQL renders only CHECK expressions in pretty mode. Every other constraint keeps
// the original default renderer; JavaScript never rewrites or filters a definition.
export const constraintDefinitionSql = `CASE WHEN k.contype = 'c'
  THEN pg_get_constraintdef(k.oid, true) ELSE pg_get_constraintdef(k.oid) END`;
export const constraintMetadataSql = `SELECT jsonb_agg(jsonb_build_object(
  'schema',n.nspname,'table',c.relname,'name',k.conname,'type',k.contype,
  'definition',${constraintDefinitionSql},
  'enforcementAvailable',to_jsonb(k) ? 'conenforced','enforced',to_jsonb(k)->'conenforced',
  'validated',k.convalidated,'deferrable',k.condeferrable,'deferred',k.condeferred,
  'isLocal',k.conislocal,'inheritanceCount',k.coninhcount,'noInherit',k.connoinherit,
  'parent',CASE WHEN k.conparentid=0 THEN NULL ELSE jsonb_build_object('schema',pn.nspname,'table',pc.relname,'name',pk.conname) END,
  'columns',ARRAY(SELECT a.attname FROM unnest(k.conkey) WITH ORDINALITY AS linked(attnum,ordinality)
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=linked.attnum ORDER BY linked.ordinality),
  'referencedSchema',rn.nspname,'referencedTable',rc.relname,
  'referencedColumns',ARRAY(SELECT a.attname FROM unnest(k.confkey) WITH ORDINALITY AS linked(attnum,ordinality)
    LEFT JOIN pg_attribute a ON a.attrelid=rc.oid AND a.attnum=linked.attnum ORDER BY linked.ordinality)
  ) ORDER BY n.nspname,c.relname,k.conname)
  FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  LEFT JOIN pg_class rc ON rc.oid=k.confrelid LEFT JOIN pg_namespace rn ON rn.oid=rc.relnamespace
  LEFT JOIN pg_constraint pk ON pk.oid=k.conparentid LEFT JOIN pg_class pc ON pc.oid=pk.conrelid
  LEFT JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE n.nspname='public'`;

export const columnMetadataSql = `SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,
  'name',a.attname,'position',a.attnum,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull)
  ORDER BY n.nspname,c.relname,a.attnum)
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped`;

// Fail closed on an incomplete source capture as well as unequal restored metadata.
// PostgreSQL 16/17 lack conenforced: record absence, never imply it was measured there.
export function validateSchemaMetadata({constraints, columns} = {}) {
  const requireThat = condition => { if (!condition) throw Error('Incomplete or invalid constraint/column metadata'); };
  const text = value => typeof value === 'string' && value.length > 0;
  const identity = item => JSON.stringify([item.schema,item.table,item.name]);
  const tableNames = new Set(recoveryTables), columnNames = new Set(), positions = new Set(), tableColumns = new Set();
  requireThat(Array.isArray(columns) && columns.length > 0 && Array.isArray(constraints) && constraints.length > 0);
  for (const column of columns) {
    requireThat(column.schema === 'public' && tableNames.has(column.table) && text(column.name) && text(column.type)
      && Number.isSafeInteger(column.position) && column.position > 0 && typeof column.notNull === 'boolean');
    const key = identity(column), position = JSON.stringify([column.schema,column.table,column.position]);
    requireThat(!columnNames.has(key) && !positions.has(position));
    columnNames.add(key); positions.add(position); tableColumns.add(column.table);
  }
  requireThat(recoveryTables.every(table => tableColumns.has(table)));
  const constraintNames = new Set();
  for (const constraint of constraints) {
    requireThat(constraint.schema === 'public' && tableNames.has(constraint.table) && text(constraint.name)
      && ['c','f','p','u','t','x','n'].includes(constraint.type) && text(constraint.definition)
      && typeof constraint.enforcementAvailable === 'boolean'
      && (constraint.enforcementAvailable ? constraint.enforced === true : constraint.enforced === null)
      && constraint.validated === true && typeof constraint.deferrable === 'boolean' && typeof constraint.deferred === 'boolean'
      && (!constraint.deferred || constraint.deferrable) && typeof constraint.isLocal === 'boolean'
      && Number.isSafeInteger(constraint.inheritanceCount) && constraint.inheritanceCount >= 0 && typeof constraint.noInherit === 'boolean');
    const key = identity(constraint);
    requireThat(!constraintNames.has(key)); constraintNames.add(key);
    const linked = (names,schema,table) => Array.isArray(names) && new Set(names).size === names.length
      && names.every(name => columnNames.has(identity({schema,table,name})));
    requireThat(linked(constraint.columns,constraint.schema,constraint.table));
    if (['f','p','u','n'].includes(constraint.type)) requireThat(constraint.columns.length > 0);
    if (constraint.type === 'f') requireThat(constraint.columns.length > 0
      && linked(constraint.referencedColumns,constraint.referencedSchema,constraint.referencedTable)
      && constraint.referencedColumns.length === constraint.columns.length);
    else requireThat(constraint.referencedSchema === null && constraint.referencedTable === null
      && Array.isArray(constraint.referencedColumns) && constraint.referencedColumns.length === 0);
    requireThat(constraint.parent === null || (constraint.parent.schema === 'public' && tableNames.has(constraint.parent.table) && text(constraint.parent.name)));
  }
  for (const constraint of constraints) if (constraint.parent !== null) requireThat(constraintNames.has(identity(constraint.parent)));
  requireThat(constraints.some(constraint => constraint.type === 'c' && constraint.table === 'equipment_command_receipt'
    && constraint.columns.includes('idempotency_key')));
  requireThat(columns.some(column => column.table === 'equipment_command_receipt' && column.name === 'idempotency_key' && column.notNull));
}
