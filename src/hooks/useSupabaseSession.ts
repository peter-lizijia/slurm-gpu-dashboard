import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { upsertProfileFromUser } from "../services/auth";
import { isDemo } from "../config";
import { demoSession } from "../data/demo";
import { supabase } from "../services/supabaseClient";

function getRedirectUrl() {
  return `${window.location.origin}${window.location.pathname}`;
}

export function useSupabaseSession() {
  const [session, setSession] = useState<Session | null>(isDemo ? demoSession : null);
  const [isLoading, setIsLoading] = useState(!isDemo);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    let isMounted = true;

    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!isMounted) {
          return;
        }

        if (error) {
          setAuthError(error.message);
        }

        setSession(data.session);
      })
      .finally(() => {
        if (isMounted) {
          setIsLoading(false);
        }
      });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setIsLoading(false);
      setAuthError(null);
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (isDemo || !session?.user) {
      return;
    }

    void upsertProfileFromUser(session.user).catch((error: Error) => {
      setAuthError(error.message);
    });
  }, [session]);

  const signInWithGoogle = useCallback(async () => {
    if (!supabase) return;
    setAuthError(null);

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: getRedirectUrl(),
        queryParams: {
          // Let people switch to an approved account.
          prompt: "select_account",
        },
      },
    });

    if (error) {
      setAuthError(error.message);
    }
  }, []);

  const signOut = useCallback(async () => {
    if (!supabase) return;
    setAuthError(null);

    const { error } = await supabase.auth.signOut();
    if (error) {
      setAuthError(error.message);
    }
  }, []);

  return {
    authError,
    isLoading,
    session,
    signInWithGoogle,
    signOut,
  };
}
