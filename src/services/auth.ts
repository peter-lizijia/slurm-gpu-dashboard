import type { User } from "@supabase/supabase-js";
import { requireSupabase } from "./supabaseClient";

function getDisplayName(user: User) {
  const metadata = user.user_metadata;

  return (
    metadata.full_name ??
    metadata.name ??
    "Lab member"
  );
}

export async function upsertProfileFromUser(user: User) {
  const metadata = user.user_metadata;

  const { error } = await requireSupabase().from("profiles").upsert({
    id: user.id,
    email: user.email ?? null,
    full_name: getDisplayName(user),
    avatar_url: metadata.avatar_url ?? metadata.picture ?? null,
  });

  if (error) {
    throw error;
  }
}
