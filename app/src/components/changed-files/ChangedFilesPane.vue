<template>
  <aside class="changed-files">
    <div class="pane-title">Changed Files</div>
    <div v-if="files.length === 0" class="empty">No changed files</div>
    <ChangedFileRow
      v-for="file in files"
      :key="file.id"
      :file="file"
      :active="file.id === activeFileId"
      @select="$emit('selectFile', $event)"
    />
  </aside>
</template>

<script setup lang="ts">
import type { ChangedFile } from '../../lib/protocol'
import ChangedFileRow from './ChangedFileRow.vue'

defineProps<{
  files: ChangedFile[]
  activeFileId?: string 
}>()

defineEmits<{
  selectFile: [fileId: string]
}>()
</script>

<style scoped lang="scss">
.changed-files {
  min-width: 0;
  height: 100%;
  padding: 12px;
  overflow: auto;
  border-right: 1px solid #252a35;
  background: #151821;
}

.pane-title {
  margin-bottom: 10px;
  color: #7e8aa0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.empty {
  color: #6e7685;
  font-size: 13px;
}
</style>
