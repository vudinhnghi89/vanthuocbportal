ALTER TABLE "issuer_aliases" ADD COLUMN "alias_norm" text NOT NULL;--> statement-breakpoint
ALTER TABLE "issuer_aliases" ADD CONSTRAINT "issuer_aliases_alias_norm_unique" UNIQUE("alias_norm");