<template>
  <section class="adapters">
    <h2 id="agentAdapters-settings-title">Agent Adapters</h2>

    <p>
      Only launch trusted executables. Permission denial is not an operating-system sandbox. Credentials belong in the adapter or your
      environment, never in arguments or profile names.
    </p>

    <p v-if="error" role="alert">{{ error }}</p>

    <p>
      ACP uses Diffuse's session-scoped MCP tools. Old generated <code>.opencode/tools/diffuse_review.ts</code> files are preserved, but
      their Node bridge is retired. If your adapter auto-loads one, explicitly disable or remove that obsolete generated tool when
      configuring the adapter. Legacy provider/model/agent overrides are not translated into flags automatically.
    </p>

    <Panel v-for="item in adapters" :key="item.adapter.id">
      <Badge :tone="item.available && item.platformSupported ? 'success' : 'warning'">{{
        !item.platformSupported ? 'Unsupported platform' : item.available ? 'Available' : 'Executable missing'
      }}</Badge>

      <Button variant="ghost" @click="edit(item.adapter)">{{ item.adapter.id }}</Button>
    </Panel>

    <Panel>
      <form @submit.prevent="save">
        <label>Adapter ID<input v-model="form.id" required maxlength="256" /></label>

        <label>Absolute executable path<input v-model="form.executable" required /></label>

        <label>Arguments (one per line; no shell parsing or secrets)<textarea v-model="args" rows="4" /></label>

        <label>Environment key allowlist (one key per line, not values)<textarea v-model="environmentKeys" rows="4" /></label>

        <label>Authentication profile reference (not a credential)<input v-model="profile" maxlength="256" autocomplete="off" /></label>

        <label><input v-model="form.multiplex" type="checkbox" /> Allow multiple sessions on a capable host</label>

        <p>
          Environment values are resolved by the native core at launch. They are not displayed or stored here. Enable multiplexing only for
          adapters that safely support concurrent sessions.
        </p>

        <Button type="submit" :disabled="saving">Save adapter</Button>
      </form>
    </Panel>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { isAcpAdapter, type AcpAdapter, type AcpDiscovery } from '../../lib/acpContract';
import Button from '../Button.vue';
import Panel from '../ui/Panel.vue';
import Badge from '../ui/Badge.vue';
const adapters = ref<AcpDiscovery[]>([]);
const form = ref<AcpAdapter>({ id: '', executable: '', args: [], environmentKeys: [], authenticationProfile: null, multiplex: false });
const args = ref('');
const environmentKeys = ref('');
const profile = ref('');
const error = ref('');
const saving = ref(false);
function edit(adapter: AcpAdapter) {
  form.value = { ...adapter };
  args.value = adapter.args.join('\n');
  environmentKeys.value = adapter.environmentKeys.join('\n');
  profile.value = adapter.authenticationProfile ?? '';
}
async function load() {
  adapters.value = await window.diffuse.discoverAcpAdapters();
}
async function save() {
  error.value = '';
  saving.value = true;
  try {
    const adapter = {
      ...form.value,
      args: args.value ? args.value.split('\n') : [],
      environmentKeys: environmentKeys.value
        .split('\n')
        .map((key) => key.trim())
        .filter(Boolean),
      authenticationProfile: profile.value.trim() || null,
    };
    if (!isAcpAdapter(adapter))
      throw new Error(
        'Use an absolute executable path, valid environment keys, and bounded arguments. Credential flags and secret assignments must use environment-key references instead.',
      );
    await window.diffuse.saveAcpAdapter(adapter);
    await load();
  } catch (e) {
    error.value = String(e);
  } finally {
    saving.value = false;
  }
}
void load().catch((e) => {
  error.value = String(e);
});
</script>

<style scoped lang="scss">
.adapters,
form,
label {
  display: grid;
  gap: var(--space-5);
  min-width: 0;
}
input,
textarea {
  padding: var(--space-4);
  background: var(--color-bg-inset);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border-default);
  border-radius: var(--radius-3);
}
input:focus-visible,
textarea:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}
</style>
