// STON.fi routers (v1 and v2 constant-product): https://api.ston.fi/v1/routers (read 2026-11-20), each pool is checked
// on-chain with the router's own get_pool_address. DeDust factory: https://docs.dedust.io/reference/factory
// Release data rule (DESIGN §5.4): contract addresses ship in reader code, never in the signed bundle files.
export const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
/** Proxy-TON masters stand for native TON inside STON.fi pools. */
export const PTON = ['EQCM3B12QK1e4yZSf8GtBRT0aLMNyEsBc_DhVfRRtOEffLez', 'EQBnGWMCf3-FZZq1W4IWcWiGAc3PHuZ0_H-7sad2oY00o83S']
export const QUOTES = ['native', USDT]
export const DEDUST_FACTORY = 'EQBfBWT7X2BHg9tXAxzhz2aKiNTU1tpt5NsiK0uSDW_YAJ67'
export const STONFI_V1 = 'EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt'
export const STONFI_V2 = new Set([
  'EQBwpBGEAb-NgjUxpmARAgVl8C4F_5GsXxZ3dpsA1qzQerNl',
  'EQByADL5Ra2dldrMSBctgfSm2X2W1P61NVW2RYDb8eJNJGx6',
  'EQDAPye7HAPAAl4WXpz5jOCdhf2H9h9QkkzRQ-6K5usiuQeC',
  'EQChoROpuUM4cpN6IRzqNTrkP9iVZHYoHgxMABDVU28vlUiG',
  'EQDTb1w1TCohFqnNcyPrrbbBJQdAwwPn8DbCoaSUd0S5T4fB',
  'EQAJG5pyZPWEiQiMVJdf7bDRgRLzg6QR57qKeRsOrMO-ncZN',
  'EQC67o2-2UzR1cJFrUGL5M7OAnLgG8oY_tHaTgGmR63LQNV-',
  'EQDi1eWU3HWWst8owY8OMq2Dz9nJJEHUROza8R-_wEGb8yu6',
  'EQCx0HDJ_DxLxDSQyfsEqHI8Rs65nygvdmeD9Ra7rY15OWN8',
  'EQCDT9dCT52pdfsLNW0e6qP5T3cgq7M4Ug72zkGYgP17tsWD',
  'EQBzkqAN4ViYdS24lD2fFPe8odHn2rUkfMYbEJ88EBKBAS1b',
  'EQCpuYtq55nhkwYDmL4OWjsrdYy83gj5_49nNRQ5CrPOze49',
  'EQCxkYVQcfXKw9uJ-MMtutvR2Cu0DVCZFfLNBp6NwXgO8vQY',
  'EQBQ_UBQvR9ryUjKDwijtoiyyga2Wl-yJm6Y8gl0k-HDh_5x',
  'EQDwyjgjnTXJVPjXji3OPtUilcCjceGVQOLGwr9_sRLjImfG',
  'EQATvO_BXfkFocOXhlve01EZfsiyFjoV-0k9CLmpgwtzVtcN',
  'EQDh5oHPvfRwPu2bORBGCoLEO4WQZKL4fk5DD1gydeNG9oEH',
  'EQAsa5p_UWxUDaU9n9bo3CAv2xRNrNFjadhm70JQAesdVt_5',
  'EQCCdNmj4QbNjrg_PM-JJE-B9f_czXLkYmrO7P9UkA6tt95m',
  'EQDQ6j53q21HuZtw6oclm7z4LU2cG6S2OKvpSSMH548d7kJT',
  'EQBCtlN7Zy96qx-3yH0Yi4V0SNtQ-8RbhYaNs65MC4Hwfq31',
  'EQCS4UEa5UaJLzOyyKieqQOQ2P9M-7kXpkO5HnP3Bv250cN3',
  'EQCiypoBWNIEPlarBp04UePyEj5zH0ZDHxuRNqJ1WQx3FCY-',
  'EQBigMnbY4NU1uwdvzertV5mv_yI7282R-ffW7XZFWPEVRDG',
  'EQDx--jUU9PUtHltPYZX7wdzIi0SPY3KZ8nvOs0iZvQJd6Ql',
  'EQAiv3IuxYA6ZGEunOgZSTuMBzbpjwRbWw09-WsE-iqKKMrK',
  'EQBZj7nhXNhB4O9rRCn4qGS82DZaPUPlyM2k6ZrbvQ1j3Ge7',
  'EQCiz74FCV2lYlvFPEYhL3Jql8WwIO7QvbvYT-LQH0SmtCgI',
  'EQD11suHkrO_1Mb5IIdYFx5ZPy38MuHoeHx6dA-QRaD8w0UJ',
  'EQBjM7B2PKa82IPKrUFbMFaKeQDFGTMRnrvY1TmptC7Kxz7B',
  'EQABT9GCyDI60CbC4c6uS33HFDwaqd6MddiwIIw7CXTgNR3A',
  'EQBQErJi0DHgKYseIHtrQk4N5CQLCr3XYwkQIEw0HNs470OG',
  'EQAQYbnb1EGK0Wb8mk3vEW4vbHTyv7cOcfJlPWQ87_6_qfzR',
  'EQBCl1JANkTpMpJ9N3lZktPMpp2btRe2vVwHon0la8ibRied',
  'EQBd9vfWfn6MOqBYEEYFeyFqliOYln1znFklfp8B02zlS_Lq',
  'EQADEFMTMnC-gu5v2U0ZY8AYaGhAOk9TcECg1TOquAW3r-IE',
  'EQDBYUj5KEPUQrbj7da742UYJIeT9QU5C2dKsi12SdQ3yh9a',
  'EQAgERF5tvrNn0AM2Rrrvk-MutGP60ZL70bJPuqvCTGY-17_',
  'EQAyD7O8CvVdR8AEJcr96fHI1ifFq21S8QMt1czi5IfJPyfA',
  'EQCRgwuFbPRR7TGodkJwbjiBtNtb0hfzJIliV-5kY6lKr_18',
  'EQAyY2lBQ6RsVe88CKTmeH3BWWsUCWu7ugQNaf5kwLDYAoKt',
])
export const STONFI_API = 'https://api.ston.fi'
