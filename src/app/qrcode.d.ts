declare module "qrcode" {
	interface QRCodeOptions {
		width?: number;
		margin?: number;
		color?: { dark?: string; light?: string };
	}
	function toDataURL(text: string, options?: QRCodeOptions): Promise<string>;
	export default { toDataURL };
}
