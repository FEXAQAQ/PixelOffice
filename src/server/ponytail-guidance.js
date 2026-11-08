// Ponytail's minimal-change approach, applied to PixelOffice engineer tasks.
// Keep this short so it works with both Claude Code and Codex without a CLI plugin.
const PONYTAIL_GUIDANCE = `開發方式（Ponytail）：先檢查現有程式、框架功能與相依套件，再選能滿足需求的最小改動。能修正或重用現有程式就不要新增抽象、檔案或套件；不要順手擴大需求或做無關重構。必要的錯誤處理、安全檢查與測試不可省略。完成前檢查差異，移除這次改動造成的多餘程式，並如實回報驗證結果。`;

module.exports = {PONYTAIL_GUIDANCE};
