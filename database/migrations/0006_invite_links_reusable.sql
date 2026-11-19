-- Invite links work for anyone who has them, until they expire or an admin turns them off (they used
-- to work once). `uses` counts how many people joined with a link; used_at / used_by keep the last one.
alter table agent_invites add column uses int not null default 0 check (uses >= 0);
update agent_invites set uses = 1 where used_at is not null;
