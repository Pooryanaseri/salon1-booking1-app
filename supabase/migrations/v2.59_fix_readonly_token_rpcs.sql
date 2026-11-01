-- v2.59: fix "cannot execute INSERT in a read-only transaction" in «داشبورد من».
--
-- Supabase (PostgREST) runs functions declared STABLE in a read-only
-- transaction. These five were STABLE but check the customer's token through
-- resolve_booking_token(), whose rate limit writes a row — so every call
-- failed and the dashboard showed no price quotes, loyalty points, shop
-- orders, visit reports or packages. Marking them VOLATILE runs them in a
-- normal transaction. Nothing else changes. Safe to run more than once.
alter function public.get_my_loyalty_with_token(text) volatile;
alter function public.my_quotes_with_token(text) volatile;
alter function public.my_orders_with_token(text) volatile;
alter function public.my_visit_reports_with_token(text) volatile;
alter function public.my_packages_with_token(text) volatile;
