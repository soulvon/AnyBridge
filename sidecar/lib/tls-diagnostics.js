// TLS 客户端拒绝判定与上报给桌面的结构化事件。
//
// 独立成模块是为了让判定能被单元测试覆盖：原先它是 hybrid-server.js 里的私有函数，
// 只在特定客户端/证书组合下才暴露覆盖缺口（真实客户端拒证书时服务端看到的是
// alert number 48/46，而旧判定只认 42）。

/// 经 stdout 上报给桌面的结构化事件；桌面按相同字符串解析，
/// 改动这里必须同步 src-tauri/src/commands/proxy.rs 的事件识别分支。
export const TLS_CLIENT_CERT_REJECTED_EVENT = 'ANYBRIDGE_EVENT:TLS_CLIENT_CERT_REJECTED';

// 客户端不信任证书时可能发出的 TLS alert（RFC 8446 §6.2）。
// 只收「证书本身不可信」这一类：
//   42 bad certificate / 43 unsupported certificate / 44 certificate revoked
//   45 certificate expired / 46 certificate unknown / 48 unknown ca
// 刻意不收 51 decrypt_error：它同样可能由密钥或套件不匹配引起，
// 纳入会把无关故障误报成「证书被拒」，反而掩盖真正原因。
const CERT_REJECT_ALERT_NUMBERS = new Set([42, 43, 44, 45, 46, 48]);

// 不以 alert number 结尾的错误形态：OpenSSL 文本与 Node 侧错误码都要覆盖，
// 因为不同 OpenSSL 版本给同一情况的描述并不一致。
const CERT_REJECT_TEXT_MARKERS = [
  'bad certificate',
  'unknown ca',
  'certificate verify failed',
  'certificate has expired',
  'unable to verify',
  'unable_to_verify',
  'self signed certificate in certificate chain',
  'self_signed_cert_in_chain',
  'depth_zero_self_signed_cert',
  'cert_has_expired',
];

/// 客户端是否在 TLS 握手阶段拒掉了我们的 MITM 证书。
///
/// 判定为真意味着 MITM 直接断开、模型改写根本不会执行（表现为「还是原模型」），
/// 必须让用户在环境检测里能自查到。
export function mitmCertRejected(err) {
  const text = String((err && (err.message || err.code)) || '').toLowerCase();
  if (!text) return false;
  if (CERT_REJECT_TEXT_MARKERS.some((marker) => text.includes(marker))) {
    return true;
  }
  const alert = text.match(/alert number (\d+)/);
  return alert !== null && CERT_REJECT_ALERT_NUMBERS.has(Number(alert[1]));
}
