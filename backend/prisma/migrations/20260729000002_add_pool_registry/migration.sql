-- CreateTable
CREATE TABLE "pool_registry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "salt" TEXT NOT NULL,
    "pool_address" TEXT NOT NULL,
    "factory_address" TEXT NOT NULL,
    "admin" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "wasm_hash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deployed_ledger" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pool_registry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pool_registry_salt_key" ON "pool_registry"("salt");

-- CreateIndex
CREATE UNIQUE INDEX "pool_registry_pool_address_key" ON "pool_registry"("pool_address");

-- CreateIndex
CREATE INDEX "pool_registry_factory_address_idx" ON "pool_registry"("factory_address");

-- CreateIndex
CREATE INDEX "pool_registry_active_idx" ON "pool_registry"("active");
