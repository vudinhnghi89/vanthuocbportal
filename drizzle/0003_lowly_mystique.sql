DROP INDEX "documents_created_at_idx";--> statement-breakpoint
CREATE INDEX "documents_status_created_at_idx" ON "documents" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "documents_info_unit_idx" ON "documents" USING btree ("info_unit_id");--> statement-breakpoint
CREATE INDEX "documents_created_at_idx" ON "documents" USING btree ("created_at" DESC NULLS LAST);