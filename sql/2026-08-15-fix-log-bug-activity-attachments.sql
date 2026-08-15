-- Fix: saving a bug after adding or removing an attachment failed with
--   "Error updating bug: malformed array literal: \"attachments\"" (SQLSTATE 22P02)
--
-- Cause: in log_bug_activity(), the line
--   v_changed := v_changed || 'attachments';
-- is ambiguous. `v_changed` is text[] and the literal is untyped, so Postgres
-- resolves the operator to array_cat(anyarray, anyarray) and tries to parse
-- the string "attachments" as an array literal instead of appending it as an
-- element. The same append inside the FOREACH loop works because `f` is
-- declared text, which picks the anyarray || anyelement (append) form.
--
-- Only updates that actually changed the attachments column hit this branch,
-- which is why every other edit saved fine.
--
-- Fix: cast the literal to text.

create or replace function public.log_bug_activity()
returns trigger
language plpgsql
security definer
as $$
declare
  v_actor   text;
  v_changed text[] := '{}';
  v_summary text;
  v_action  text;
  v_title   text;
  v_bug_id  uuid;
  v_extra   int;
  fields    text[] := array['title','status','category','loe','severity','assigned_to',
                            'reporter','steps','notes','question','answer',
                            'what_was_done','how_to_test','feedback'];
  f         text;
  old_j     jsonb;
  new_j     jsonb;
begin
  begin
    v_actor := coalesce(auth.jwt() ->> 'email', auth.jwt() ->> 'role', 'api');
  exception when others then
    v_actor := 'api';
  end;

  if (TG_OP = 'INSERT') then
    v_action  := 'created';
    v_bug_id  := NEW.id;
    v_title   := NEW.title;
    v_summary := 'Added "' || NEW.title || '" to ' || bug_status_label(NEW.status);

  elsif (TG_OP = 'DELETE') then
    v_action  := 'deleted';
    v_bug_id  := OLD.id;
    v_title   := OLD.title;
    v_summary := 'Deleted "' || OLD.title || '"';

  else
    v_action := 'updated';
    v_bug_id := NEW.id;
    v_title  := NEW.title;
    old_j    := to_jsonb(OLD);
    new_j    := to_jsonb(NEW);

    foreach f in array fields loop
      if (old_j ->> f) is distinct from (new_j ->> f) then
        v_changed := v_changed || f;
      end if;
    end loop;
    if to_jsonb(OLD.attachments) is distinct from to_jsonb(NEW.attachments) then
      v_changed := v_changed || 'attachments'::text;   -- ← the fix
    end if;

    -- nothing meaningful changed → don't log
    if array_length(v_changed, 1) is null then
      return null;
    end if;

    if OLD.status is distinct from NEW.status then
      v_summary := 'Moved "' || NEW.title || '" ' ||
                   bug_status_label(OLD.status) || ' → ' || bug_status_label(NEW.status);
      v_extra := array_length(v_changed, 1) - 1;
      if v_extra > 0 then
        v_summary := v_summary || ' (+' || v_extra || ' other change' ||
                     case when v_extra = 1 then '' else 's' end || ')';
      end if;
    else
      select 'Updated "' || NEW.title || '" — ' || string_agg(bug_field_label(x), ', ' order by ord)
        into v_summary
        from unnest(v_changed) with ordinality as t(x, ord);
    end if;
  end if;

  insert into public.bug_activity (bug_id, bug_title, action, summary, changed_fields, actor)
  values (v_bug_id, v_title, v_action, v_summary, v_changed, v_actor);

  return null;
end;
$$;
