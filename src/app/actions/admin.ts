"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { hashPassword, pickAccent, requireSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { deleteStored, fetchToStorage, saveUpload, validateLicenseKey } from "@/lib/storage";
import { optionalId, resolveUserEdit } from "@/lib/form-rules";
import { passwordProblem } from "@/lib/auth-rules";
import { isMaskedKey, parseSoftwareForm, resolveStoredKey, softwareSourceProblem } from "@/lib/software-rules";
import { userDeleteProblem } from "@/lib/admin-rules";
import type { Platform, Role } from "@prisma/client";

async function requireAdmin() {
  const user = await requireSession();
  if (user.role !== "ADMIN") {
    redirect("/?error=" + encodeURIComponent("Administrator access is required for that."));
  }
  return user;
}

function backTo(path: string, message: string, ok = true): never {
  redirect(`${path}?${ok ? "flash" : "error"}=${encodeURIComponent(message)}`);
}

/* -------------------------------------------------------------------------- */
/*  Platform switches                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Turn a whole simulation surface on or off.  Because availability is derived
 * from these rows, flipping one switch immediately changes every student's
 * catalog — no cache to bust.
 */
export async function togglePlatform(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const platform = String(formData.get("platform") ?? "") as Platform;
  const enabled = formData.get("enabled") === "on" || formData.get("enabled") === "true";
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!["LINUX", "WINDOWS", "OFFICE"].includes(platform)) backTo("/admin", "Unknown platform.", false);

  await prisma.platformToggle.upsert({
    where: { platform },
    create: { platform, enabled, note, updatedAt: new Date() },
    update: { enabled, note, updatedAt: new Date() },
  });

  await recordAudit({
    actorId: admin.id,
    action: enabled ? "platform.enable" : "platform.disable",
    targetType: "platform",
    targetId: platform,
    detail: { note },
  });

  revalidatePath("/admin");
  revalidatePath("/student");
  backTo("/admin", `${platform} simulations are now ${enabled ? "enabled" : "disabled"}.`);
}

/* -------------------------------------------------------------------------- */
/*  Software inventory                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Add software to the inventory.
 *
 * Three provisioning routes, mirroring how a real lab is stocked:
 *   - INTERNAL: a simulation that ships with the platform, no payload at all;
 *   - URL: a vendor download the admin can materialise on demand;
 *   - UPLOAD: an installer the admin already has on disk.
 *
 * License handling follows the same rule: OPEN never needs a key, EVALUATION
 * runs keyless until its trial ends, and only LICENSED requires one.
 */
export async function createSoftware(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = parseSoftwareForm(formData);
  if (!parsed.ok) backTo("/admin/software", parsed.reason, false);
  const fields = parsed.fields;

  if (!fields.name) backTo("/admin/software", "Give the package a name.", false);

  if (fields.requiresKey && fields.licenseKey) {
    const problem = validateLicenseKey(fields.licenseKey);
    if (problem) backTo("/admin/software", problem, false);
  }

  let upload: { relativePath: string; fileName: string; size: number; checksum: string } | null = null;
  const file = formData.get("file");
  if (fields.source === "UPLOAD" && file instanceof File && file.size > 0) {
    try {
      upload = await saveUpload(file);
    } catch (error) {
      backTo("/admin/software", (error as Error).message, false);
    }
  }

  const sourceProblem = softwareSourceProblem(fields.source, fields.sourceUrl, Boolean(upload));
  if (sourceProblem) backTo("/admin/software", sourceProblem, false);

  const existing = await prisma.softwarePackage.findFirst({
    where: { name: fields.name, version: fields.version, platform: fields.platform },
  });
  if (existing) {
    backTo("/admin/software", `${fields.name} ${fields.version ?? ""} already exists for ${fields.platform}.`, false);
  }

  const record = await prisma.softwarePackage.create({
    data: {
      name: fields.name,
      vendor: fields.vendor,
      version: fields.version,
      flavour: fields.flavour,
      description: fields.description,
      platform: fields.platform,
      source: fields.source,
      sourceUrl: fields.sourceUrl,
      uploadPath: upload?.relativePath ?? null,
      uploadName: upload?.fileName ?? null,
      sizeBytes: upload ? BigInt(upload.size) : null,
      checksum: upload?.checksum ?? null,
      licenseType: fields.licenseType,
      requiresKey: fields.requiresKey,
      licenseKey: fields.licenseKey,
      licenseSeats: fields.licenseSeats,
      licenseExpiresAt: fields.licenseExpiresAt,
      enabled: fields.enabled,
      createdById: admin.id,
    },
  });

  await recordAudit({
    actorId: admin.id,
    action: "software.create",
    targetType: "softwarePackage",
    targetId: record.id,
    detail: { name: record.name, source: record.source, licenseType: record.licenseType },
  });

  revalidatePath("/admin/software");
  revalidatePath("/admin");
  backTo("/admin/software", `${record.name} was added to the inventory.`);
}

export async function updateSoftware(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const parsed = parseSoftwareForm(formData);
  if (!parsed.ok) backTo("/admin/software", parsed.reason, false);
  const fields = parsed.fields;
  if (!fields.name) backTo("/admin/software", "Give the package a name.", false);
  const existing = await prisma.softwarePackage.findUnique({ where: { id } });
  if (!existing) backTo("/admin/software", "That package no longer exists.", false);

  if (fields.requiresKey && fields.licenseKey && !isMaskedKey(fields.licenseKey)) {
    const problem = validateLicenseKey(fields.licenseKey);
    if (problem) backTo("/admin/software", problem, false);
  }

  // A replacement installer, accepted exactly as `createSoftware` accepts one.
  // Without this an edit silently ignored a newly chosen file.
  let upload: { relativePath: string; fileName: string; size: number; checksum: string } | null = null;
  const file = formData.get("file");
  if (fields.source === "UPLOAD" && file instanceof File && file.size > 0) {
    try {
      upload = await saveUpload(file);
    } catch (error) {
      backTo("/admin/software", (error as Error).message, false);
    }
  }

  // Keep the same source rules the create form enforces: an edit must not leave
  // a URL package with no link, or an UPLOAD package with no file.
  const sourceProblem = softwareSourceProblem(
    fields.source,
    fields.sourceUrl,
    Boolean(upload) || Boolean(existing.uploadPath),
  );
  if (sourceProblem) backTo("/admin/software", sourceProblem, false);

  // (name, version, platform) is unique; renaming onto another package's
  // identity would otherwise surface as an unhandled constraint error.
  const clash = await prisma.softwarePackage.findFirst({
    where: { name: fields.name, version: fields.version, platform: fields.platform, NOT: { id } },
  });
  if (clash) {
    backTo("/admin/software", `${fields.name} ${fields.version ?? ""} already exists for ${fields.platform}.`, false);
  }

  // A masked value in the field means "leave the stored key alone".
  const licenseKey = resolveStoredKey(fields.licenseKey, existing.licenseKey);

  await prisma.softwarePackage.update({
    where: { id },
    data: {
      name: fields.name || existing.name,
      vendor: fields.vendor,
      version: fields.version,
      flavour: fields.flavour,
      description: fields.description,
      platform: fields.platform,
      source: fields.source,
      sourceUrl: fields.sourceUrl,
      // Only replace the stored payload when a new installer was supplied;
      // otherwise the existing file stays where it is.
      ...(upload
        ? {
            uploadPath: upload.relativePath,
            uploadName: upload.fileName,
            sizeBytes: BigInt(upload.size),
            checksum: upload.checksum,
          }
        : {}),
      licenseType: fields.licenseType,
      requiresKey: fields.requiresKey,
      licenseKey,
      licenseSeats: fields.licenseSeats,
      licenseExpiresAt: fields.licenseExpiresAt,
      enabled: fields.enabled,
    },
  });

  // The row now points at the new installer, so the replaced file on disk is
  // unreachable — remove it best-effort rather than leave it behind.
  if (upload && existing.uploadPath && existing.uploadPath !== upload.relativePath) {
    await deleteStored(existing.uploadPath).catch(() => undefined);
  }

  await recordAudit({
    actorId: admin.id,
    action: "software.update",
    targetType: "softwarePackage",
    targetId: id,
    detail: { name: fields.name, enabled: fields.enabled },
  });

  revalidatePath("/admin/software");
  revalidatePath("/student");
  backTo("/admin/software", `${fields.name || existing.name} was updated.`);
}

/** Quick enable/disable straight from the inventory list. */
export async function setSoftwareEnabled(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const enabled = formData.get("enabled") === "true";
  const record = await prisma.softwarePackage.update({ where: { id }, data: { enabled } }).catch(() => null);
  if (!record) backTo("/admin/software", "That package no longer exists.", false);

  await recordAudit({
    actorId: admin.id,
    action: enabled ? "software.enable" : "software.disable",
    targetType: "softwarePackage",
    targetId: id,
    detail: { name: record.name },
  });

  revalidatePath("/admin/software");
  revalidatePath("/student");
  backTo("/admin/software", `${record.name} is now ${enabled ? "enabled" : "disabled"}.`);
}

/** Store or rotate an activation key. */
export async function setLicenseKey(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const key = String(formData.get("licenseKey") ?? "").trim();

  const problem = validateLicenseKey(key);
  if (problem) backTo("/admin/software", problem, false);

  const record = await prisma.softwarePackage
    .update({
      where: { id },
      data: { licenseKey: key, licenseType: "LICENSED", requiresKey: true },
    })
    .catch(() => null);
  if (!record) backTo("/admin/software", "That package no longer exists.", false);

  await recordAudit({
    actorId: admin.id,
    action: "software.set_key",
    targetType: "softwarePackage",
    targetId: id,
    // Never log the key itself.
    detail: { name: record.name },
  });

  revalidatePath("/admin/software");
  revalidatePath("/student");
  backTo("/admin/software", `Activation key stored for ${record.name}.`);
}

/** Pull a URL-sourced package into local storage. */
export async function downloadSoftware(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const record = await prisma.softwarePackage.findUnique({ where: { id } });
  if (!record) backTo("/admin/software", "That package no longer exists.", false);
  if (!record.sourceUrl) backTo("/admin/software", `${record.name} has no download URL configured.`, false);

  try {
    const stored = await fetchToStorage(record.sourceUrl, `${record.name}${record.version ? `-${record.version}` : ""}.pkg`);
    await prisma.softwarePackage.update({
      where: { id },
      data: {
        uploadPath: stored.relativePath,
        uploadName: stored.fileName,
        sizeBytes: BigInt(stored.size),
        checksum: stored.checksum,
      },
    });
    await recordAudit({
      actorId: admin.id,
      action: "software.download",
      targetType: "softwarePackage",
      targetId: id,
      detail: { bytes: stored.size },
    });
    revalidatePath("/admin/software");
    backTo("/admin/software", `Downloaded ${stored.fileName} (${stored.size} bytes).`);
  } catch (error) {
    backTo("/admin/software", (error as Error).message, false);
  }
}

export async function deleteSoftware(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const record = await prisma.softwarePackage.findUnique({ where: { id }, include: { _count: { select: { scenarios: true } } } });
  if (!record) backTo("/admin/software", "That package no longer exists.", false);

  if (record._count.scenarios > 0) {
    backTo(
      "/admin/software",
      `${record.name} is still required by ${record._count.scenarios} scenario(s). Detach it first.`,
      false,
    );
  }

  await deleteStored(record.uploadPath).catch(() => undefined);
  await prisma.softwarePackage.delete({ where: { id } });

  await recordAudit({
    actorId: admin.id,
    action: "software.delete",
    targetType: "softwarePackage",
    targetId: id,
    detail: { name: record.name },
  });

  revalidatePath("/admin/software");
  backTo("/admin/software", `${record.name} was removed from the inventory.`);
}

/* -------------------------------------------------------------------------- */
/*  People                                                                    */
/* -------------------------------------------------------------------------- */

const ROLE_VALUES: Role[] = ["ADMIN", "INSTRUCTOR", "STUDENT"];

export async function createUser(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "STUDENT") as Role;
  const cohortId = optionalId(formData.get("cohortId"));

  if (!name) backTo("/admin/users", "Enter the person's name.", false);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) backTo("/admin/users", "That email address looks wrong.", false);
  const passwordIssue = passwordProblem(password);
  if (passwordIssue) backTo("/admin/users", passwordIssue, false);
  if (!ROLE_VALUES.includes(role)) backTo("/admin/users", "Unknown role.", false);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) backTo("/admin/users", "An account with that email already exists.", false);

  // A stale class id would otherwise fail silently inside the `catch` below and
  // leave the new account outside the class the admin thought they picked.
  if (cohortId) {
    const cohort = await prisma.cohort.findUnique({ where: { id: cohortId }, select: { id: true } });
    if (!cohort) backTo("/admin/users", "That class no longer exists.", false);
  }

  const created = await prisma.user.create({
    data: { name, email, passwordHash: await hashPassword(password), role, accent: pickAccent(email) },
  });

  if (cohortId) {
    await prisma.cohortMember.create({ data: { cohortId, userId: created.id } }).catch(() => undefined);
  }

  await recordAudit({
    actorId: admin.id,
    action: "user.create",
    targetType: "user",
    targetId: created.id,
    detail: { email, role },
  });

  revalidatePath("/admin/users");
  backTo("/admin/users", `${name} can now sign in as ${role.toLowerCase()}.`);
}

export async function updateUser(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) backTo("/admin/users", "That account no longer exists.", false);

  // The role select and active checkbox are disabled when an administrator
  // edits their own row, and a disabled control submits nothing. The rule that
  // resolves those fields lives in `form-rules` so it can be unit tested.
  const { role, active, error } = resolveUserEdit({
    isSelf: user.id === admin.id,
    requestedRole: String(formData.get("role") ?? ""),
    validRoles: ROLE_VALUES,
    activeField: formData.get("active"),
    currentRole: user.role,
    currentActive: user.active,
  });
  if (error) backTo("/admin/users", error, false);
  if (password) {
    const passwordIssue = passwordProblem(password);
    if (passwordIssue) backTo("/admin/users", passwordIssue, false);
  }

  await prisma.user.update({
    where: { id },
    data: {
      name: name || user.name,
      role,
      active,
      ...(password ? { passwordHash: await hashPassword(password) } : {}),
    },
  });

  await recordAudit({
    actorId: admin.id,
    action: "user.update",
    targetType: "user",
    targetId: id,
    detail: { role, active, passwordReset: Boolean(password) },
  });

  revalidatePath("/admin/users");
  backTo("/admin/users", `${name || user.name} was updated.`);
}

export async function deleteUser(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = String(formData.get("id") ?? "");
  if (id === admin.id) backTo("/admin/users", "You cannot delete your own account.", false);

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) backTo("/admin/users", "That account no longer exists.", false);

  // Scenarios cascade from their author, and every attempt cascades from its
  // scenario. Deleting an instructor would therefore throw away the catalog
  // work *and* the recorded attempts of every student who ran it, so refuse
  // rather than lose it silently.
  const authored = await prisma.scenario.count({ where: { authorId: id } });
  const problem = userDeleteProblem(user.name, authored);
  if (problem) backTo("/admin/users", problem, false);

  await prisma.user.delete({ where: { id } });
  await recordAudit({
    actorId: admin.id,
    action: "user.delete",
    targetType: "user",
    targetId: id,
    detail: { email: user.email },
  });

  revalidatePath("/admin/users");
  backTo("/admin/users", `${user.name} was removed.`);
}
