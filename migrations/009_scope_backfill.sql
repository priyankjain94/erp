-- projects created before v1.12: their existing items become their scope of work
insert into project_scope(project_id, room_name, room_code, type, descr, value, source, item_id, sort)
select i.project_id, i.room_name, i.room_code, i.type, i.descr, coalesce(i.value, 0), 'manual', i.id, row_number() over (partition by i.project_id order by i.id)
from items i where i.scope_id is null and not exists (select 1 from project_scope s where s.item_id = i.id);
update items i set scope_id = s.id from project_scope s where s.item_id = i.id and i.scope_id is null;
